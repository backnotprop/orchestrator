import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createClaudeLimitReader,
  createCodexLimitReader,
  createCopilotLimitReader,
  readProviderLimits,
  unavailableProviderLimitSnapshot,
  type ProviderLimitReader,
  type ProviderLimitSnapshot,
} from "@backnotprop/orchestrator-core/provider-limits";
import { createCodexAppServerLimitSource } from "../packages/core/src/provider-limits/codex-app-server.ts";
import { createCodexOAuthLimitSource } from "../packages/core/src/provider-limits/codex-oauth.ts";

const fixedNow = new Date("2026-07-08T12:00:00.000Z");
const primaryReset = Math.floor((fixedNow.getTime() + 60 * 60 * 1000) / 1000);
const secondaryReset = Math.floor((fixedNow.getTime() + 24 * 60 * 60 * 1000) / 1000);

test("provider limits coordinate snapshots for built-in providers", async () => {
  const readers = ["codex", "copilot", "claude"].map(
    (provider): ProviderLimitReader => ({
      provider,
      async read(input) {
        return unavailableProviderLimitSnapshot({
          provider: input.provider,
          now: input.now ?? fixedNow,
          code: "not_implemented",
          message: `${provider} reader is not wired.`,
        });
      },
    }),
  );

  const report = await readProviderLimits({
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    now: fixedNow,
    readers,
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, fixedNow.toISOString());
  assert.deepEqual(
    report.providers.map((provider) => provider.provider),
    ["codex", "copilot", "claude"],
  );
  for (const provider of report.providers) {
    assert.equal(provider.status, "unavailable");
    assert.equal(provider.confidence, "unknown");
    assert.deepEqual(provider.windows, []);
    assert.equal(provider.updatedAt, fixedNow.toISOString());
    assert.equal(provider.error?.code, "not_implemented");
  }
});

test("provider limit reader failures are isolated and redacted", async () => {
  const readers: ProviderLimitReader[] = [
    {
      provider: "codex",
      async read() {
        throw new Error("Bearer secret-token failed with access_token=secret-access");
      },
    },
    {
      provider: "copilot",
      async read(input) {
        return unavailableProviderLimitSnapshot({
          provider: input.provider,
          now: input.now ?? fixedNow,
          code: "not_implemented",
          message: "Copilot reader is not wired.",
        });
      },
    },
  ];

  const report = await readProviderLimits({
    providers: ["codex", "copilot"],
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    now: fixedNow,
    readers,
  });

  const codex = report.providers.find((provider) => provider.provider === "codex");
  assert.equal(codex?.status, "unavailable");
  assert.equal(codex?.error?.code, "reader_failed");
  assert.match(codex?.error?.message ?? "", /Bearer \[redacted\]/);
  assert.match(codex?.error?.message ?? "", /access_token=\[redacted\]/);
  assert.doesNotMatch(codex?.error?.message ?? "", /secret-token|secret-access/);

  const copilot = report.providers.find((provider) => provider.provider === "copilot");
  assert.equal(copilot?.error?.code, "not_implemented");
});

test("codex app-server source maps account windows credits and reset credits", async () => {
  const source = createCodexAppServerLimitSource({
    async readAccount() {
      return {
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      };
    },
    async readRateLimits() {
      return {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 42,
            windowDurationMins: 60,
            resetsAt: primaryReset,
          },
          secondary: {
            usedPercent: 5,
            windowDurationMins: 1440,
            resetsAt: secondaryReset,
          },
          individualLimit: {
            limit: "25000",
            used: "8000",
            remainingPercent: 68,
            resetsAt: secondaryReset,
          },
          planType: "pro",
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 60,
              resetsAt: primaryReset,
            },
          },
          codex_spark: {
            limitId: "codex_spark",
            limitName: "Codex Spark",
            primary: {
              usedPercent: 88,
              windowDurationMins: 30,
              resetsAt: primaryReset,
            },
          },
        },
        rateLimitResetCredits: {
          availableCount: 2,
        },
      };
    },
  });

  const snapshot = await source.read({
    provider: "codex",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.source, "codex-app-server");
  assert.equal(snapshot.account?.email, "user@example.com");
  assert.equal(snapshot.account?.plan, "pro");
  assert.equal(snapshot.windows[0]?.usedPercent, 42);
  assert.equal(snapshot.windows[0]?.resetDescription, "1h");
  assert.equal(snapshot.windows[1]?.usedPercent, 5);
  assert.equal(snapshot.windows[2]?.id, "codex_spark:primary");
  assert.equal(snapshot.credits?.limit, 25_000);
  assert.equal(snapshot.credits?.used, 8_000);
  assert.equal(snapshot.credits?.remaining, 17_000);
  assert.equal(snapshot.resetCredits?.availableCount, 2);
});

test("codex app-server source returns auth_missing without thread or turn work", async () => {
  let rateLimitsRead = false;
  const source = createCodexAppServerLimitSource({
    async readAccount() {
      return {
        account: null,
        requiresOpenaiAuth: true,
      };
    },
    async readRateLimits() {
      rateLimitsRead = true;
      return {};
    },
  });

  const snapshot = await source.read({
    provider: "codex",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.error?.code, "auth_missing");
  assert.equal(rateLimitsRead, false);
});

test("codex reader falls back from app-server to OAuth when OAuth is available", async () => {
  const reader = createCodexLimitReader({
    sources: [
      {
        source: "codex-app-server",
        async read(input) {
          return unavailableProviderLimitSnapshot({
            provider: input.provider,
            now: input.now ?? fixedNow,
            code: "codex_app_server_unavailable",
            message: "app-server unavailable",
          });
        },
      },
      {
        source: "codex-oauth",
        async read(input) {
          return availableCodexSnapshot(input.now ?? fixedNow, "codex-oauth");
        },
      },
    ],
  });

  const snapshot = await reader.read({
    provider: "codex",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.source, "codex-oauth");
});

test("codex reader does not call OAuth when app-server is available", async () => {
  let oauthCalled = false;
  const reader = createCodexLimitReader({
    sources: [
      {
        source: "codex-app-server",
        async read(input) {
          return availableCodexSnapshot(input.now ?? fixedNow, "codex-app-server");
        },
      },
      {
        source: "codex-oauth",
        async read(input) {
          oauthCalled = true;
          return availableCodexSnapshot(input.now ?? fixedNow, "codex-oauth");
        },
      },
    ],
  });

  const snapshot = await reader.read({
    provider: "codex",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.source, "codex-app-server");
  assert.equal(oauthCalled, false);
});

test("codex OAuth source prefers CODEX_HOME over home directory auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-codex-limits-"));
  const codexHome = join(root, "codex-home");
  const homeDir = join(root, "home");
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      join(codexHome, "auth.json"),
      `${JSON.stringify({
        tokens: {
          access_token: "codex-home-access",
          refresh_token: "codex-home-refresh",
        },
        last_refresh: fixedNow.toISOString(),
      })}\n`,
    );
    await writeFile(
      join(homeDir, ".codex", "auth.json"),
      `${JSON.stringify({
        tokens: {
          access_token: "home-access",
          refresh_token: "home-refresh",
        },
        last_refresh: fixedNow.toISOString(),
      })}\n`,
    );

    const source = createCodexOAuthLimitSource({
      env: { CODEX_HOME: codexHome },
      homeDir,
      async httpClient(request) {
        assert.equal(request.headers.Authorization, "Bearer codex-home-access");
        return successfulUsageResponse(request.url);
      },
    });

    const snapshot = await source.read({
      provider: "codex",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.windows[0]?.usedPercent, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex OAuth source supports camelCase token files", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestrator-codex-limits-"));
  try {
    await writeFile(
      join(home, "auth.json"),
      `${JSON.stringify({
        tokens: {
          accessToken: "camel-access",
          refreshToken: "camel-refresh",
          accountId: "camel-account",
        },
        last_refresh: fixedNow.toISOString(),
      })}\n`,
    );

    const source = createCodexOAuthLimitSource({
      env: { CODEX_HOME: home },
      async httpClient(request) {
        assert.equal(request.headers.Authorization, "Bearer camel-access");
        assert.equal(request.headers["ChatGPT-Account-Id"], "camel-account");
        return successfulUsageResponse(request.url);
      },
    });

    const snapshot = await source.read({
      provider: "codex",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "available");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("codex OAuth source reports API-key-only auth as unavailable", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestrator-codex-limits-"));
  try {
    await writeFile(
      join(home, "auth.json"),
      `${JSON.stringify({
        OPENAI_API_KEY: "sk-test",
        tokens: null,
        last_refresh: null,
      })}\n`,
    );

    const source = createCodexOAuthLimitSource({
      env: { CODEX_HOME: home },
      async httpClient() {
        throw new Error("HTTP should not be called without OAuth tokens");
      },
    });

    const snapshot = await source.read({
      provider: "codex",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.error?.code, "oauth_tokens_missing");
    assert.match(snapshot.error?.hint ?? "", /ChatGPT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("codex OAuth source maps invalid refresh tokens to a re-login hint", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestrator-codex-limits-"));
  try {
    await writeFile(
      join(home, "auth.json"),
      `${JSON.stringify({
        tokens: {
          access_token: "old-access",
          refresh_token: "expired-refresh",
        },
        last_refresh: "2026-06-01T00:00:00.000Z",
      })}\n`,
    );

    const seen: string[] = [];
    const source = createCodexOAuthLimitSource({
      env: { CODEX_HOME: home },
      now: fixedNow,
      async httpClient(request) {
        seen.push(request.method);
        assert.equal(request.method, "POST");
        return {
          status: 401,
          body: JSON.stringify({ error: "invalid_grant" }),
        };
      },
    });

    const snapshot = await source.read({
      provider: "codex",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.deepEqual(seen, ["POST"]);
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.error?.code, "oauth_refresh_failed");
    assert.match(snapshot.error?.hint ?? "", /log in again/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("codex OAuth source refreshes credentials and maps usage plus reset credits", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestrator-codex-limits-"));
  try {
    await writeFile(
      join(home, "auth.json"),
      `${JSON.stringify(
        {
          tokens: {
            access_token: "old-access",
            refresh_token: "old-refresh",
            account_id: "account-123",
          },
          last_refresh: "2026-06-01T00:00:00.000Z",
          preserved: true,
        },
        null,
        2,
      )}\n`,
    );

    const seen: string[] = [];
    const source = createCodexOAuthLimitSource({
      env: { CODEX_HOME: home },
      now: fixedNow,
      async httpClient(request) {
        seen.push(`${request.method} ${request.url}`);
        if (request.method === "POST") {
          assert.match(request.body ?? "", /old-refresh/);
          return {
            status: 200,
            body: JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              id_token: "new-id",
            }),
          };
        }
        assert.equal(request.headers.Authorization, "Bearer new-access");
        if (request.url.endsWith("/wham/rate-limit-reset-credits")) {
          return {
            status: 200,
            body: JSON.stringify({
              available_count: 1,
              credits: [
                { status: "used", expires_at: "2026-07-08T12:00:00.000Z" },
                { status: "available", expires_at: "2026-07-07T00:00:00.000Z" },
                { status: "available", expires_at: "2026-07-09T00:00:00.000Z" },
              ],
            }),
          };
        }
        return {
          status: 200,
          body: JSON.stringify({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 12,
                reset_at: primaryReset,
                limit_window_seconds: 3600,
              },
              secondary_window: {
                used_percent: 34,
                reset_at: secondaryReset,
                limit_window_seconds: 86400,
              },
            },
            individual_limit: {
              limit: "100",
              used: "25",
              remaining_percent: 75,
              resets_at: secondaryReset,
            },
            additional_rate_limits: [
              {
                limit_name: "Codex Spark",
                rate_limit: {
                  primary_window: {
                    used_percent: 56,
                    reset_at: primaryReset,
                    limit_window_seconds: 1800,
                  },
                },
              },
            ],
          }),
        };
      },
    });

    const snapshot = await source.read({
      provider: "codex",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 9_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.source, "codex-oauth");
    assert.equal(snapshot.account?.plan, "pro");
    assert.equal(snapshot.windows[0]?.usedPercent, 12);
    assert.equal(snapshot.windows[1]?.usedPercent, 34);
    assert.equal(snapshot.windows[2]?.id, "Codex Spark:primary");
    assert.equal(snapshot.credits?.limit, 100);
    assert.equal(snapshot.credits?.remaining, 75);
    assert.equal(snapshot.resetCredits?.availableCount, 1);
    assert.equal(snapshot.resetCredits?.nextExpiresAt, "2026-07-09T00:00:00.000Z");
    assert.deepEqual(seen, [
      "POST https://auth.openai.com/oauth/token",
      "GET https://chatgpt.com/backend-api/wham/usage",
      "GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ]);

    const saved = JSON.parse(await readFile(join(home, "auth.json"), "utf8")) as {
      tokens: { access_token: string; refresh_token: string; id_token: string };
      preserved: boolean;
    };
    assert.equal(saved.tokens.access_token, "new-access");
    assert.equal(saved.tokens.refresh_token, "new-refresh");
    assert.equal(saved.tokens.id_token, "new-id");
    assert.equal(saved.preserved, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("codex OAuth source treats reset-credit failures as additive", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestrator-codex-limits-"));
  try {
    await writeFile(
      join(home, "auth.json"),
      `${JSON.stringify({
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
        },
        last_refresh: fixedNow.toISOString(),
      })}\n`,
    );

    const source = createCodexOAuthLimitSource({
      env: { CODEX_HOME: home },
      async httpClient(request) {
        if (request.url.endsWith("/wham/rate-limit-reset-credits")) {
          return { status: 500, body: "nope" };
        }
        return {
          status: 200,
          body: JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 12,
                reset_at: primaryReset,
                limit_window_seconds: 3600,
              },
            },
          }),
        };
      },
    });

    const snapshot = await source.read({
      provider: "codex",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.windows[0]?.usedPercent, 12);
    assert.equal(snapshot.resetCredits, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("copilot reader prefers COPILOT_API_TOKEN and maps premium chat and completions", async () => {
  const reader = createCopilotLimitReader({
    env: {
      COPILOT_API_TOKEN: "copilot-token",
      GITHUB_TOKEN: "github-token",
      GH_TOKEN: "gh-token",
    },
    async ghTokenCommand() {
      throw new Error("gh should not be called when env token exists");
    },
    async httpClient(request) {
      assert.equal(request.headers.Authorization, "token copilot-token");
      assert.equal(request.url, "https://api.github.com/copilot_internal/user");
      return successfulCopilotResponse();
    },
  });

  const snapshot = await reader.read({
    provider: "copilot",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.source, "copilot-api");
  assert.equal(snapshot.account?.username, "backnotprop");
  assert.equal(snapshot.account?.plan, "individual");
  assert.equal(snapshot.account?.loginMethod, "github");
  assert.equal(snapshot.windows[0]?.id, "premium");
  assert.equal(snapshot.windows[0]?.label, "Premium");
  assert.equal(snapshot.windows[0]?.usedPercent, 31.1);
  assert.equal(snapshot.windows[0]?.remainingPercent, 68.9);
  assert.equal(snapshot.windows[0]?.resetDescription, "2d");
  assert.equal(snapshot.windows[1]?.id, "chat");
  assert.equal(snapshot.windows[1]?.usedPercent, 0);
  assert.equal(snapshot.windows[1]?.resetDescription, undefined);
  assert.equal(snapshot.windows[2]?.id, "completions");
  assert.equal(snapshot.windows[2]?.usedPercent, 50);
});

test("copilot reader falls back through GitHub token environment variables", async () => {
  const seen: string[] = [];
  for (const [env, expected] of [
    [{ GITHUB_TOKEN: "github-token" }, "github-token"],
    [{ GH_TOKEN: "gh-token" }, "gh-token"],
  ] as const) {
    const reader = createCopilotLimitReader({
      env,
      async httpClient(request) {
        seen.push(request.headers.Authorization);
        return successfulCopilotResponse();
      },
    });

    const snapshot = await reader.read({
      provider: "copilot",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "available");
    assert.equal(seen.at(-1), `token ${expected}`);
  }
});

test("copilot reader falls back to GitHub CLI token", async () => {
  let ghCalled = false;
  const reader = createCopilotLimitReader({
    env: {},
    async ghTokenCommand() {
      ghCalled = true;
      return { ok: true, token: "gh-cli-token" };
    },
    async httpClient(request) {
      assert.equal(request.headers.Authorization, "token gh-cli-token");
      return successfulCopilotResponse();
    },
  });

  const snapshot = await reader.read({
    provider: "copilot",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "available");
  assert.equal(ghCalled, true);
});

test("copilot reader reports missing auth when no token exists", async () => {
  const reader = createCopilotLimitReader({
    env: {},
    async ghTokenCommand() {
      return {
        ok: false,
        code: "auth_missing",
        message: "No token.",
      };
    },
    async httpClient() {
      throw new Error("HTTP should not be called without a token");
    },
  });

  const snapshot = await reader.read({
    provider: "copilot",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.error?.code, "auth_missing");
});

test("copilot reader maps auth and invalid response failures", async () => {
  for (const [status, code] of [
    [401, "auth_failed"],
    [403, "auth_failed"],
    [404, "provider_unavailable"],
  ] as const) {
    const reader = createCopilotLimitReader({
      env: { COPILOT_API_TOKEN: "token" },
      async httpClient() {
        return { status, body: "{}" };
      },
    });

    const snapshot = await reader.read({
      provider: "copilot",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.error?.code, code);
  }

  const malformed = createCopilotLimitReader({
    env: { COPILOT_API_TOKEN: "token" },
    async httpClient() {
      return { status: 200, body: "nope" };
    },
  });
  const snapshot = await malformed.read({
    provider: "copilot",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.error?.code, "invalid_provider_response");
});

test("copilot reader returns partial account snapshot without usable windows", async () => {
  const reader = createCopilotLimitReader({
    env: { COPILOT_API_TOKEN: "token" },
    async httpClient() {
      return {
        status: 200,
        body: JSON.stringify({
          login: "backnotprop",
          copilot_plan: "individual",
          token_based_billing: true,
          quota_snapshots: {
            premium_interactions: {
              entitlement: 0,
              remaining: 0,
              percent_remaining: 0,
            },
          },
        }),
      };
    },
  });

  const snapshot = await reader.read({
    provider: "copilot",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.account?.username, "backnotprop");
  assert.equal(snapshot.windows.length, 0);
});

test("copilot reader redacts token-looking dependency errors", async () => {
  const reader = createCopilotLimitReader({
    env: { COPILOT_API_TOKEN: "secret-token" },
    async httpClient() {
      throw new Error("token secret-token failed with access_token=secret-access");
    },
  });

  const snapshot = await reader.read({
    provider: "copilot",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.error?.code, "provider_unavailable");
  assert.match(snapshot.error?.message ?? "", /token \[redacted\]/);
  assert.match(snapshot.error?.message ?? "", /access_token=\[redacted\]/);
  assert.doesNotMatch(snapshot.error?.message ?? "", /secret-token|secret-access/);
});

test("claude reader uses environment token and maps usage windows and credits", async () => {
  let authStatusCalled = false;
  const reader = createClaudeLimitReader({
    env: { CLAUDE_OAUTH_ACCESS_TOKEN: "claude-env-token" },
    async authStatusCommand() {
      authStatusCalled = true;
      return { ok: false, code: "auth_missing", message: "should not be called" };
    },
    async httpClient(request) {
      assert.equal(request.url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(request.headers.Authorization, "Bearer claude-env-token");
      assert.equal(request.headers["anthropic-beta"], "oauth-2025-04-20");
      return successfulClaudeResponse();
    },
  });

  const snapshot = await reader.read({
    provider: "claude",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.source, "claude-oauth");
  assert.equal(snapshot.account?.loginMethod, "claude-oauth");
  assert.equal(snapshot.windows[0]?.id, "session");
  assert.equal(snapshot.windows[0]?.usedPercent, 18.3);
  assert.equal(snapshot.windows[0]?.remainingPercent, 81.7);
  assert.equal(snapshot.windows[0]?.resetDescription, "3h");
  assert.equal(snapshot.windows[1]?.id, "weekly");
  assert.equal(snapshot.windows[1]?.usedPercent, 42);
  assert.equal(snapshot.windows[2]?.id, "sonnet-weekly");
  assert.equal(snapshot.windows[3]?.id, "opus-weekly");
  assert.equal(snapshot.windows[4]?.id, "daily-routines");
  assert.match(snapshot.windows[5]?.id ?? "", /^scoped:claude-opus-4:/);
  assert.equal(snapshot.windows[5]?.label, "Opus 4 week");
  assert.equal(snapshot.credits?.used, 12.5);
  assert.equal(snapshot.credits?.limit, 50);
  assert.equal(snapshot.credits?.remaining, 37.5);
  assert.equal(snapshot.credits?.unit, "USD");
  assert.equal(authStatusCalled, false);
});

test("claude reader uses credentials file when env token is absent", async () => {
  const home = await mkdtemp(join(tmpdir(), "orchestrator-claude-limits-"));
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", ".credentials.json"),
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-token",
          refreshToken: "file-refresh",
          expiresAt: fixedNow.getTime() + 60_000,
          scopes: ["user:profile"],
          rateLimitTier: "default_claude_max_5x",
          subscriptionType: "max",
        },
      })}\n`,
    );

    const reader = createClaudeLimitReader({
      env: {},
      homeDir: home,
      async httpClient(request) {
        assert.equal(request.headers.Authorization, "Bearer file-token");
        return successfulClaudeResponse();
      },
    });

    const snapshot = await reader.read({
      provider: "claude",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.account?.plan, "max");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude reader reports unusable credential files without falling back", async () => {
  for (const [body, code] of [
    [{ mcpOAuth: { accessToken: "mcp" } }, "oauth_credentials_missing"],
    [
      {
        claudeAiOauth: {
          accessToken: "expired",
          expiresAt: fixedNow.getTime() - 1,
          scopes: ["user:profile"],
        },
      },
      "oauth_refresh_required",
    ],
    [
      {
        claudeAiOauth: {
          accessToken: "scope",
          expiresAt: fixedNow.getTime() + 60_000,
          scopes: ["user:inference"],
        },
      },
      "scope_missing",
    ],
  ] as const) {
    const home = await mkdtemp(join(tmpdir(), "orchestrator-claude-limits-"));
    try {
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(join(home, ".claude", ".credentials.json"), `${JSON.stringify(body)}\n`);
      const reader = createClaudeLimitReader({
        env: {},
        homeDir: home,
        async authStatusCommand() {
          throw new Error("auth status should not hide actionable OAuth failures");
        },
        async httpClient() {
          throw new Error("HTTP should not run without usable credentials");
        },
      });

      const snapshot = await reader.read({
        provider: "claude",
        workspaceRoot: "/tmp/orchestrator-provider-limits",
        timeoutMs: 5_000,
        now: fixedNow,
      });

      assert.equal(snapshot.status, "unavailable");
      assert.equal(snapshot.error?.code, code);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("claude reader maps auth rate-limit and invalid response failures", async () => {
  for (const [status, body, code] of [
    [401, "{}", "auth_failed"],
    [403, "{}", "auth_failed"],
    [403, "missing user:profile", "scope_missing"],
    [429, "{}", "provider_rate_limited"],
  ] as const) {
    const reader = createClaudeLimitReader({
      env: { CLAUDE_OAUTH_ACCESS_TOKEN: "token" },
      async authStatusCommand() {
        throw new Error("auth status should not hide actionable OAuth failures");
      },
      async httpClient() {
        return { status, body };
      },
    });

    const snapshot = await reader.read({
      provider: "claude",
      workspaceRoot: "/tmp/orchestrator-provider-limits",
      timeoutMs: 5_000,
      now: fixedNow,
    });

    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.error?.code, code);
  }

  const malformed = createClaudeLimitReader({
    env: { CLAUDE_OAUTH_ACCESS_TOKEN: "token" },
    async httpClient() {
      return { status: 200, body: "nope" };
    },
  });
  const snapshot = await malformed.read({
    provider: "claude",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.error?.code, "invalid_provider_response");
});

test("claude reader maps camelCase extra usage credits", async () => {
  const reader = createClaudeLimitReader({
    env: { CLAUDE_OAUTH_ACCESS_TOKEN: "token" },
    async httpClient() {
      return {
        status: 200,
        body: JSON.stringify({
          extraUsage: {
            isEnabled: true,
            usedCredits: "1250",
            monthlyLimit: "5000",
            currency: "USD",
          },
        }),
      };
    },
  });

  const snapshot = await reader.read({
    provider: "claude",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.credits?.used, 12.5);
  assert.equal(snapshot.credits?.limit, 50);
  assert.equal(snapshot.credits?.remaining, 37.5);
});

test("claude reader falls back to CLI auth status for partial account data", async () => {
  const reader = createClaudeLimitReader({
    env: {},
    credentialsPath: join(tmpdir(), "missing-claude-credentials.json"),
    async authStatusCommand() {
      return {
        ok: true,
        status: {
          loggedIn: true,
          authMethod: "claude.ai",
          email: "user@example.com",
          orgId: "org-123",
          orgName: "Example Org",
          subscriptionType: "max",
        },
      };
    },
    async httpClient() {
      throw new Error("HTTP should not run without OAuth credentials");
    },
  });

  const snapshot = await reader.read({
    provider: "claude",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.source, "claude-cli");
  assert.equal(snapshot.account?.email, "user@example.com");
  assert.equal(snapshot.account?.organization, "Example Org");
  assert.equal(snapshot.account?.plan, "max");
  assert.equal(snapshot.account?.loginMethod, "claude.ai");
  assert.equal(snapshot.error?.code, "usage_unavailable");
});

test("claude reader reports auth missing when no OAuth or CLI status exists", async () => {
  const reader = createClaudeLimitReader({
    env: {},
    credentialsPath: join(tmpdir(), "missing-claude-credentials.json"),
    async authStatusCommand() {
      return { ok: false, code: "auth_missing", message: "No Claude auth." };
    },
    async httpClient() {
      throw new Error("HTTP should not run without OAuth credentials");
    },
  });

  const snapshot = await reader.read({
    provider: "claude",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.error?.code, "auth_missing");
});

test("claude reader redacts token-looking dependency errors", async () => {
  const reader = createClaudeLimitReader({
    env: { CLAUDE_OAUTH_ACCESS_TOKEN: "secret-token" },
    async authStatusCommand() {
      throw new Error("auth status should not be needed");
    },
    async httpClient() {
      throw new Error("Bearer secret-token failed with access_token=secret-access");
    },
  });

  const snapshot = await reader.read({
    provider: "claude",
    workspaceRoot: "/tmp/orchestrator-provider-limits",
    timeoutMs: 5_000,
    now: fixedNow,
  });

  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.error?.code, "provider_unavailable");
  assert.match(snapshot.error?.message ?? "", /Bearer \[redacted\]/);
  assert.match(snapshot.error?.message ?? "", /access_token=\[redacted\]/);
  assert.doesNotMatch(snapshot.error?.message ?? "", /secret-token|secret-access/);
});

function successfulUsageResponse(url: string): { status: number; body: string } {
  if (url.endsWith("/wham/rate-limit-reset-credits")) {
    return {
      status: 200,
      body: JSON.stringify({ available_count: 0, credits: [] }),
    };
  }
  return {
    status: 200,
    body: JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 12,
          reset_at: primaryReset,
          limit_window_seconds: 3600,
        },
      },
    }),
  };
}

function successfulCopilotResponse(): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      login: "backnotprop",
      copilot_plan: "individual",
      quota_reset_date_utc: "2026-07-10T12:00:00.000Z",
      quota_snapshots: {
        premium_interactions: {
          percent_remaining: 68.9,
          quota_reset_at: 0,
        },
        chat: {
          unlimited: true,
          percentRemaining: 100,
          quotaResetAt: "2026-07-10T12:00:00.000Z",
        },
        completions: {
          entitlement: "100",
          quota_remaining: "50",
        },
      },
    }),
  };
}

function successfulClaudeResponse(): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      five_hour: {
        utilization: 18.25,
        resets_at: new Date(fixedNow.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      },
      seven_day: {
        utilization: 42,
        resets_at: new Date(fixedNow.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      },
      seven_day_sonnet: {
        utilization: 21,
        resets_at: new Date(fixedNow.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
      seven_day_opus: {
        utilization: 55.5,
        resets_at: new Date(fixedNow.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      },
      seven_day_cowork: {
        utilization: 12,
        resets_at: new Date(fixedNow.getTime() + 6 * 60 * 60 * 1000).toISOString(),
      },
      limits: [
        {
          percent: 66.6,
          resets_at: new Date(fixedNow.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          scope: {
            model: {
              id: "claude-opus-4",
              display_name: "Opus 4",
            },
          },
        },
      ],
      extra_usage: {
        is_enabled: true,
        used_credits: 1250,
        monthly_limit: 5000,
        currency: "USD",
      },
    }),
  };
}

function availableCodexSnapshot(
  now: Date,
  source: ProviderLimitSnapshot["source"],
): ProviderLimitSnapshot {
  return {
    provider: "codex",
    status: "available",
    source,
    confidence: "exact",
    account: { email: "user@example.com", loginMethod: "chatgpt" },
    windows: [
      {
        id: "primary",
        label: "Primary",
        usedPercent: 12,
        remainingPercent: 88,
        resetDescription: "1h",
      },
    ],
    updatedAt: now.toISOString(),
  };
}
