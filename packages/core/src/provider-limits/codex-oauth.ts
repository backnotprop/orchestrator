import {
  codexOAuthCredentialsNeedRefresh,
  loadCodexOAuthCredentials,
  refreshCodexOAuthCredentials,
  type CodexAuthResult,
  type CodexAuthHttpClient,
  type CodexAuthStoreOptions,
  type CodexOAuthCredentials,
} from "./codex-auth-store.ts";
import { codexOAuthLimitSnapshot } from "./codex-mapping.ts";
import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import type { CodexLimitSource } from "./codex-app-server.ts";
import type { ProviderLimitReaderInput } from "./types.ts";

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";

export type CodexOAuthLimitSourceOptions = CodexAuthStoreOptions & {
  readonly usageUrl?: string;
  readonly resetCreditsUrl?: string;
  readonly httpClient?: CodexAuthHttpClient;
};

type CodexUsageHttpRequest = {
  readonly url: string;
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
};

type CodexUsageHttpResponse = {
  readonly status: number;
  readonly body: string;
};

type CodexUsageHttpClient = (request: CodexUsageHttpRequest) => Promise<CodexUsageHttpResponse>;

export function createCodexOAuthLimitSource(
  options: CodexOAuthLimitSourceOptions = {},
): CodexLimitSource {
  return {
    source: "codex-oauth",
    async read(input) {
      const now = input.now ?? new Date();
      const credentials = await loadUsableCredentials(input, options, now);
      if (credentials.ok === false) {
        return unavailableProviderLimitSnapshot({
          provider: "codex",
          now,
          code: credentials.code,
          message: credentials.message,
          ...(credentials.hint ? { hint: credentials.hint } : {}),
        });
      }

      const usage = await fetchCodexUsage(credentials.value, input, options);
      if (usage.ok === false) {
        return unavailableProviderLimitSnapshot({
          provider: "codex",
          now,
          code: usage.code,
          message: usage.message,
          ...(usage.hint ? { hint: usage.hint } : {}),
        });
      }

      const resetCredits = await fetchCodexResetCredits(credentials.value, input, options);
      return codexOAuthLimitSnapshot({
        usageResponse: usage.value,
        ...(resetCredits.ok ? { resetCreditsResponse: resetCredits.value } : {}),
        now,
      });
    },
  };
}

async function loadUsableCredentials(
  input: ProviderLimitReaderInput,
  options: CodexOAuthLimitSourceOptions,
  now: Date,
): Promise<CodexAuthResult<CodexOAuthCredentials>> {
  const loaded = await loadCodexOAuthCredentials(options);
  if (loaded.ok === false) {
    return loaded;
  }
  if (!codexOAuthCredentialsNeedRefresh(loaded.value, now)) {
    return loaded;
  }
  return await refreshCodexOAuthCredentials(loaded.value, {
    ...options,
    now,
    timeoutMs: Math.max(500, Math.floor(input.timeoutMs / 3)),
  });
}

type CodexOAuthFetchResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

async function fetchCodexUsage(
  credentials: CodexOAuthCredentials,
  input: ProviderLimitReaderInput,
  options: CodexOAuthLimitSourceOptions,
): Promise<CodexOAuthFetchResult<unknown>> {
  const response = await usageHttpClient(options)({
    url: options.usageUrl ?? `${DEFAULT_CHATGPT_BASE_URL}/wham/usage`,
    method: "GET",
    timeoutMs: Math.max(500, Math.floor(input.timeoutMs / 3)),
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      ...(credentials.accountId ? { "ChatGPT-Account-Id": credentials.accountId } : {}),
    },
  });

  return decodeUsageResponse(response, "Codex usage API");
}

async function fetchCodexResetCredits(
  credentials: CodexOAuthCredentials,
  input: ProviderLimitReaderInput,
  options: CodexOAuthLimitSourceOptions,
): Promise<CodexOAuthFetchResult<unknown>> {
  try {
    const response = await usageHttpClient(options)({
      url: options.resetCreditsUrl ?? `${DEFAULT_CHATGPT_BASE_URL}/wham/rate-limit-reset-credits`,
      method: "GET",
      timeoutMs: Math.max(500, Math.floor(input.timeoutMs / 3)),
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
        "OpenAI-Beta": "codex-1",
        originator: "Codex Desktop",
        ...(credentials.accountId ? { "ChatGPT-Account-Id": credentials.accountId } : {}),
      },
    });

    return decodeUsageResponse(response, "Codex reset-credit API");
  } catch (error: unknown) {
    return {
      ok: false,
      code: "provider_unavailable",
      message: errorMessage(error),
    };
  }
}

function decodeUsageResponse(
  response: CodexUsageHttpResponse,
  label: string,
): CodexOAuthFetchResult<unknown> {
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: "auth_failed",
      message: `${label} rejected the Codex OAuth token.`,
      hint: "Run `codex` to log in again.",
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      code: "provider_unavailable",
      message: `${label} failed with HTTP ${response.status}.`,
    };
  }

  try {
    return { ok: true, value: JSON.parse(response.body) as unknown };
  } catch {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: `${label} returned invalid JSON.`,
    };
  }
}

function usageHttpClient(options: CodexOAuthLimitSourceOptions): CodexUsageHttpClient {
  if (options.httpClient) {
    return options.httpClient;
  }
  return defaultCodexUsageHttpClient;
}

async function defaultCodexUsageHttpClient(
  request: CodexUsageHttpRequest,
): Promise<CodexUsageHttpResponse> {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
