import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCliAuthStatusLimitSnapshot, claudeOAuthLimitSnapshot } from "./claude-mapping.ts";
import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import type {
  ProviderLimitReader,
  ProviderLimitReaderInput,
  ProviderLimitSnapshot,
} from "./types.ts";

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_OAUTH_USER_AGENT = "claude-code/2.1.0";
const CLAUDE_OAUTH_TOKEN_ENV_NAMES = [
  "CLAUDE_OAUTH_ACCESS_TOKEN",
  "ORCHESTRATOR_CLAUDE_OAUTH_ACCESS_TOKEN",
] as const;

export type ClaudeUsageHttpRequest = {
  readonly url: string;
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
};

export type ClaudeUsageHttpResponse = {
  readonly status: number;
  readonly body: string;
};

export type ClaudeUsageHttpClient = (
  request: ClaudeUsageHttpRequest,
) => Promise<ClaudeUsageHttpResponse>;

export type ClaudeAuthStatusCommandInput = {
  readonly timeoutMs: number;
};

export type ClaudeAuthStatusCommandResult =
  | { readonly ok: true; readonly status: unknown }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

export type ClaudeAuthStatusCommand = (
  input: ClaudeAuthStatusCommandInput,
) => Promise<ClaudeAuthStatusCommandResult>;

export type CreateClaudeLimitReaderOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly credentialsPath?: string;
  readonly usageUrl?: string;
  readonly httpClient?: ClaudeUsageHttpClient;
  readonly authStatusCommand?: ClaudeAuthStatusCommand;
};

type ClaudeOAuthCredentials = {
  readonly accessToken: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date;
  readonly rateLimitTier?: string;
  readonly subscriptionType?: string;
};

type ClaudeAuthResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

type ClaudeFetchResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

export function createClaudeLimitReader(
  options: CreateClaudeLimitReaderOptions = {},
): ProviderLimitReader {
  return {
    provider: "claude",
    async read(input) {
      return await readClaudeProviderLimit(input, options);
    },
  };
}

async function readClaudeProviderLimit(
  input: ProviderLimitReaderInput,
  options: CreateClaudeLimitReaderOptions,
): Promise<ProviderLimitSnapshot> {
  const now = input.now ?? new Date();
  const credentials = await resolveClaudeOAuthCredentials(options, now);
  if (credentials.ok) {
    const usage = await fetchClaudeUsage(credentials.value, input, options);
    if (usage.ok) {
      return claudeOAuthLimitSnapshot({
        response: usage.value,
        credentials: credentials.value,
        now,
      });
    }

    const oauthFailure = unavailableProviderLimitSnapshot({
      provider: input.provider,
      now,
      code: usage.code,
      message: usage.message,
      ...(usage.hint ? { hint: usage.hint } : {}),
    });
    if (isActionableOAuthFailure(usage.code)) {
      return oauthFailure;
    }

    return await readAuthStatusFallback(input, options, now, oauthFailure);
  }

  const credentialFailure = unavailableProviderLimitSnapshot({
    provider: input.provider,
    now,
    code: credentials.code,
    message: credentials.message,
    ...(credentials.hint ? { hint: credentials.hint } : {}),
  });
  if (isActionableOAuthFailure(credentials.code)) {
    return credentialFailure;
  }

  return await readAuthStatusFallback(input, options, now, credentialFailure);
}

async function readAuthStatusFallback(
  input: ProviderLimitReaderInput,
  options: CreateClaudeLimitReaderOptions,
  now: Date,
  fallback: ProviderLimitSnapshot,
): Promise<ProviderLimitSnapshot> {
  let status: ClaudeAuthStatusCommandResult;
  try {
    status = await (options.authStatusCommand ?? defaultClaudeAuthStatusCommand)({
      timeoutMs: Math.max(500, Math.floor(input.timeoutMs / 3)),
    });
  } catch {
    return fallback;
  }
  if (!status.ok) {
    return fallback;
  }

  return claudeCliAuthStatusLimitSnapshot({
    status: status.status,
    now,
  });
}

async function resolveClaudeOAuthCredentials(
  options: CreateClaudeLimitReaderOptions,
  now: Date,
): Promise<ClaudeAuthResult<ClaudeOAuthCredentials>> {
  const envCredentials = credentialsFromEnvironment(options.env ?? process.env);
  if (envCredentials) {
    if (!envCredentials.scopes.includes("user:profile")) {
      return {
        ok: false,
        code: "scope_missing",
        message: "Claude OAuth token is missing the user:profile scope.",
        hint: "Run `claude setup-token` to re-generate Claude credentials.",
      };
    }
    return { ok: true, value: envCredentials };
  }

  return await loadCredentialsFile(options, now);
}

function credentialsFromEnvironment(
  env: Record<string, string | undefined>,
): ClaudeOAuthCredentials | undefined {
  for (const name of CLAUDE_OAUTH_TOKEN_ENV_NAMES) {
    const token = normalizedString(env[name]);
    if (token) {
      return {
        accessToken: token,
        scopes: scopesFromEnvironment(env.CLAUDE_OAUTH_SCOPES),
      };
    }
  }
  return undefined;
}

async function loadCredentialsFile(
  options: CreateClaudeLimitReaderOptions,
  now: Date,
): Promise<ClaudeAuthResult<ClaudeOAuthCredentials>> {
  const credentialsPath =
    options.credentialsPath ?? join(options.homeDir ?? homedir(), ".claude", ".credentials.json");
  let raw: string;
  try {
    raw = await readFile(credentialsPath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        ok: false,
        code: "auth_missing",
        message: "Claude OAuth credentials were not available.",
        hint: "Set CLAUDE_OAUTH_ACCESS_TOKEN or run `claude auth status` to verify Claude CLI auth.",
      };
    }
    return {
      ok: false,
      code: "auth_read_failed",
      message: errorMessage(error),
    };
  }

  return parseClaudeCredentialsFile(raw, now);
}

function parseClaudeCredentialsFile(
  raw: string,
  now: Date,
): ClaudeAuthResult<ClaudeOAuthCredentials> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Claude OAuth credentials file contained invalid JSON.",
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Claude OAuth credentials file had an invalid shape.",
    };
  }

  const oauth = recordValue(parsed.claudeAiOauth);
  if (!oauth) {
    return {
      ok: false,
      code: "oauth_credentials_missing",
      message: isRecord(parsed.mcpOAuth)
        ? "Claude credentials contain MCP OAuth state only, not Claude provider OAuth."
        : "Claude OAuth credentials were missing from the credentials file.",
      hint: "Set CLAUDE_OAUTH_ACCESS_TOKEN or refresh Claude Code authentication.",
    };
  }

  const accessToken = normalizedString(oauth.accessToken);
  if (!accessToken) {
    return {
      ok: false,
      code: "oauth_credentials_missing",
      message: "Claude OAuth access token was missing from the credentials file.",
      hint: "Set CLAUDE_OAUTH_ACCESS_TOKEN or refresh Claude Code authentication.",
    };
  }

  const expiresAt = dateFromMillis(oauth.expiresAt);
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: "oauth_refresh_required",
      message: "Claude OAuth access token is expired.",
      hint: "Run `claude setup-token` or refresh Claude Code authentication.",
    };
  }

  const scopes = scopesFromValue(oauth.scopes);
  if (!scopes.includes("user:profile")) {
    return {
      ok: false,
      code: "scope_missing",
      message: "Claude OAuth token is missing the user:profile scope.",
      hint: "Run `claude setup-token` to re-generate Claude credentials.",
    };
  }

  const rateLimitTier = normalizedString(oauth.rateLimitTier);
  const subscriptionType = normalizedString(oauth.subscriptionType);
  return {
    ok: true,
    value: {
      accessToken,
      scopes,
      ...(expiresAt ? { expiresAt } : {}),
      ...(rateLimitTier ? { rateLimitTier } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
    },
  };
}

async function fetchClaudeUsage(
  credentials: ClaudeOAuthCredentials,
  input: ProviderLimitReaderInput,
  options: CreateClaudeLimitReaderOptions,
): Promise<ClaudeFetchResult<unknown>> {
  let response: ClaudeUsageHttpResponse;
  try {
    response = await usageHttpClient(options)({
      url: options.usageUrl ?? CLAUDE_OAUTH_USAGE_URL,
      method: "GET",
      timeoutMs: Math.max(500, Math.floor(input.timeoutMs / 2)),
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
        "User-Agent": CLAUDE_OAUTH_USER_AGENT,
      },
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return {
        ok: false,
        code: "timeout",
        message: `Timed out reading Claude provider limits after ${input.timeoutMs}ms.`,
      };
    }
    return {
      ok: false,
      code: "provider_unavailable",
      message: errorMessage(error),
    };
  }

  return decodeClaudeUsageResponse(response);
}

function decodeClaudeUsageResponse(response: ClaudeUsageHttpResponse): ClaudeFetchResult<unknown> {
  if (response.status === 401) {
    return {
      ok: false,
      code: "auth_failed",
      message: "Claude OAuth usage API rejected the token.",
      hint: "Refresh Claude Code authentication or set a fresh CLAUDE_OAUTH_ACCESS_TOKEN.",
    };
  }
  if (response.status === 403) {
    if (response.body.includes("user:profile")) {
      return {
        ok: false,
        code: "scope_missing",
        message: "Claude OAuth token does not have the user:profile scope.",
        hint: "Run `claude setup-token` to re-generate Claude credentials.",
      };
    }
    return {
      ok: false,
      code: "auth_failed",
      message: "Claude OAuth usage API rejected the token.",
      hint: "Refresh Claude Code authentication or set a fresh CLAUDE_OAUTH_ACCESS_TOKEN.",
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      code: "provider_rate_limited",
      message: "Claude OAuth usage API is rate limited.",
      hint: "Wait a few minutes and retry.",
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      code: "provider_unavailable",
      message: `Claude OAuth usage API failed with HTTP ${response.status}.`,
    };
  }

  try {
    return { ok: true, value: JSON.parse(response.body) as unknown };
  } catch {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Claude OAuth usage API returned invalid JSON.",
    };
  }
}

function usageHttpClient(options: CreateClaudeLimitReaderOptions): ClaudeUsageHttpClient {
  return options.httpClient ?? defaultClaudeUsageHttpClient;
}

async function defaultClaudeUsageHttpClient(
  request: ClaudeUsageHttpRequest,
): Promise<ClaudeUsageHttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  timeout.unref();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      signal: controller.signal,
    });
    return {
      status: response.status,
      body: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function defaultClaudeAuthStatusCommand(
  input: ClaudeAuthStatusCommandInput,
): Promise<ClaudeAuthStatusCommandResult> {
  return await new Promise<ClaudeAuthStatusCommandResult>((resolve) => {
    execFile(
      "claude",
      ["auth", "status", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 64_000,
        timeout: input.timeoutMs,
      },
      (error, stdout) => {
        if (error) {
          resolve({
            ok: false,
            code: "auth_missing",
            message: "Claude CLI auth status was unavailable.",
            hint: "Run `claude auth status`.",
          });
          return;
        }

        try {
          resolve({ ok: true, status: JSON.parse(stdout) as unknown });
        } catch {
          resolve({
            ok: false,
            code: "invalid_provider_response",
            message: "Claude CLI auth status returned invalid JSON.",
          });
        }
      },
    );
  });
}

function isActionableOAuthFailure(code: string): boolean {
  return (
    code === "auth_failed" ||
    code === "oauth_credentials_missing" ||
    code === "oauth_refresh_required" ||
    code === "scope_missing" ||
    code === "invalid_provider_response"
  );
}

function scopesFromEnvironment(raw: string | undefined): readonly string[] {
  const parsed = scopesFromString(raw);
  return parsed.length > 0 ? parsed : ["user:profile"];
}

function scopesFromValue(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const scope = normalizedString(item);
    return scope ? [scope] : [];
  });
}

function scopesFromString(raw: string | undefined): readonly string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function dateFromMillis(value: unknown): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value);
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
