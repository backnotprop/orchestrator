import { execFile } from "node:child_process";
import { copilotApiLimitSnapshot } from "./copilot-mapping.ts";
import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import type {
  ProviderLimitReader,
  ProviderLimitReaderInput,
  ProviderLimitSnapshot,
} from "./types.ts";

const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const COPILOT_TOKEN_ENV_NAMES = ["COPILOT_API_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const;

export type CopilotUsageHttpRequest = {
  readonly url: string;
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
};

export type CopilotUsageHttpResponse = {
  readonly status: number;
  readonly body: string;
};

export type CopilotUsageHttpClient = (
  request: CopilotUsageHttpRequest,
) => Promise<CopilotUsageHttpResponse>;

export type CopilotGhTokenCommandInput = {
  readonly timeoutMs: number;
};

export type CopilotGhTokenCommandResult =
  | { readonly ok: true; readonly token: string }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

export type CopilotGhTokenCommand = (
  input: CopilotGhTokenCommandInput,
) => Promise<CopilotGhTokenCommandResult>;

export type CreateCopilotLimitReaderOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly usageUrl?: string;
  readonly httpClient?: CopilotUsageHttpClient;
  readonly ghTokenCommand?: CopilotGhTokenCommand;
};

type TokenResult =
  | { readonly ok: true; readonly token: string }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

type CopilotFetchResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

export function createCopilotLimitReader(
  options: CreateCopilotLimitReaderOptions = {},
): ProviderLimitReader {
  return {
    provider: "copilot",
    async read(input) {
      return await readCopilotProviderLimit(input, options);
    },
  };
}

async function readCopilotProviderLimit(
  input: ProviderLimitReaderInput,
  options: CreateCopilotLimitReaderOptions,
): Promise<ProviderLimitSnapshot> {
  const now = input.now ?? new Date();
  const token = await resolveCopilotToken(input, options);
  if (!token.ok) {
    return unavailableProviderLimitSnapshot({
      provider: input.provider,
      now,
      code: token.code,
      message: token.message,
      ...(token.hint ? { hint: token.hint } : {}),
    });
  }

  const usage = await fetchCopilotUsage(token.token, input, options);
  if (!usage.ok) {
    return unavailableProviderLimitSnapshot({
      provider: input.provider,
      now,
      code: usage.code,
      message: usage.message,
      ...(usage.hint ? { hint: usage.hint } : {}),
    });
  }

  return copilotApiLimitSnapshot({
    response: usage.value,
    now,
  });
}

async function resolveCopilotToken(
  input: ProviderLimitReaderInput,
  options: CreateCopilotLimitReaderOptions,
): Promise<TokenResult> {
  const env = options.env ?? process.env;
  for (const name of COPILOT_TOKEN_ENV_NAMES) {
    const token = normalizedToken(env[name]);
    if (token) {
      return { ok: true, token };
    }
  }

  const command = options.ghTokenCommand ?? defaultGhTokenCommand;
  const result = await command({ timeoutMs: Math.max(500, Math.floor(input.timeoutMs / 3)) });
  if (!result.ok) {
    return result;
  }

  const token = normalizedToken(result.token);
  if (!token) {
    return missingTokenResult();
  }

  return { ok: true, token };
}

async function fetchCopilotUsage(
  token: string,
  input: ProviderLimitReaderInput,
  options: CreateCopilotLimitReaderOptions,
): Promise<CopilotFetchResult<unknown>> {
  let response: CopilotUsageHttpResponse;
  try {
    response = await copilotHttpClient(options)({
      url: options.usageUrl ?? COPILOT_USAGE_URL,
      method: "GET",
      timeoutMs: Math.max(500, Math.floor(input.timeoutMs / 2)),
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return {
        ok: false,
        code: "timeout",
        message: `Timed out reading Copilot provider limits after ${input.timeoutMs}ms.`,
      };
    }
    return {
      ok: false,
      code: "provider_unavailable",
      message: errorMessage(error),
    };
  }

  return decodeCopilotUsageResponse(response);
}

function decodeCopilotUsageResponse(
  response: CopilotUsageHttpResponse,
): CopilotFetchResult<unknown> {
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: "auth_failed",
      message: "GitHub rejected the Copilot usage token.",
      hint: "Run `gh auth login` or set COPILOT_API_TOKEN.",
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      code: "provider_unavailable",
      message: "GitHub Copilot usage endpoint was not available for this account.",
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      code: "provider_unavailable",
      message: `GitHub Copilot usage API failed with HTTP ${response.status}.`,
    };
  }

  try {
    const value: unknown = JSON.parse(response.body);
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "GitHub Copilot usage API returned invalid JSON.",
    };
  }
}

function copilotHttpClient(options: CreateCopilotLimitReaderOptions): CopilotUsageHttpClient {
  return options.httpClient ?? defaultCopilotUsageHttpClient;
}

async function defaultCopilotUsageHttpClient(
  request: CopilotUsageHttpRequest,
): Promise<CopilotUsageHttpResponse> {
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

async function defaultGhTokenCommand(
  input: CopilotGhTokenCommandInput,
): Promise<CopilotGhTokenCommandResult> {
  return await new Promise<CopilotGhTokenCommandResult>((resolve) => {
    execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      {
        encoding: "utf8",
        maxBuffer: 64_000,
        timeout: input.timeoutMs,
      },
      (error, stdout) => {
        if (error) {
          resolve(missingTokenResult());
          return;
        }

        const token = normalizedToken(stdout);
        if (!token) {
          resolve(missingTokenResult());
          return;
        }

        resolve({ ok: true, token });
      },
    );
  });
}

function missingTokenResult(): CopilotGhTokenCommandResult {
  return {
    ok: false,
    code: "auth_missing",
    message: "No GitHub token was available for reading Copilot provider limits.",
    hint: "Set COPILOT_API_TOKEN, GITHUB_TOKEN, GH_TOKEN, or run `gh auth login`.",
  };
}

function normalizedToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token ? token : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
