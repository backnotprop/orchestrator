import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CODEX_OAUTH_REFRESH_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

export type CodexOAuthCredentials = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken?: string;
  readonly accountId?: string;
  readonly lastRefresh?: Date;
  readonly authPath: string;
};

export type CodexAuthStoreOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly httpClient?: CodexAuthHttpClient;
  readonly refreshUrl?: string;
  readonly now?: Date;
};

export type CodexAuthHttpRequest = {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs: number;
};

export type CodexAuthHttpResponse = {
  readonly status: number;
  readonly body: string;
};

export type CodexAuthHttpClient = (request: CodexAuthHttpRequest) => Promise<CodexAuthHttpResponse>;

export type CodexAuthResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

export async function loadCodexOAuthCredentials(
  options: CodexAuthStoreOptions = {},
): Promise<CodexAuthResult<CodexOAuthCredentials>> {
  const authPath = codexAuthPath(options);
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        ok: false,
        code: "auth_missing",
        message: "Codex auth.json not found.",
        hint: "Run `codex` to log in.",
      };
    }
    return {
      ok: false,
      code: "auth_read_failed",
      message: errorMessage(error),
    };
  }

  const parsed = parseJsonRecord(raw);
  if (parsed.ok === false) {
    return parsed;
  }

  const tokens = parsed.value.tokens;
  if (!isRecord(tokens)) {
    if (typeof parsed.value.OPENAI_API_KEY === "string" && parsed.value.OPENAI_API_KEY) {
      return {
        ok: false,
        code: "oauth_tokens_missing",
        message: "Codex auth.json contains an API key but no OAuth tokens.",
        hint: "Run `codex` and sign in with ChatGPT.",
      };
    }
    return {
      ok: false,
      code: "oauth_tokens_missing",
      message: "Codex auth.json exists but contains no OAuth tokens.",
      hint: "Run `codex` and sign in with ChatGPT.",
    };
  }

  const accessToken = stringValue(tokens.access_token) ?? stringValue(tokens.accessToken);
  const refreshToken = stringValue(tokens.refresh_token) ?? stringValue(tokens.refreshToken);
  if (!accessToken || !refreshToken) {
    return {
      ok: false,
      code: "oauth_tokens_missing",
      message: "Codex OAuth tokens are incomplete.",
      hint: "Run `codex` and sign in with ChatGPT.",
    };
  }

  const idToken = stringValue(tokens.id_token) ?? stringValue(tokens.idToken);
  const accountId = stringValue(tokens.account_id) ?? stringValue(tokens.accountId);
  const lastRefresh = dateValue(parsed.value.last_refresh);

  return {
    ok: true,
    value: {
      accessToken,
      refreshToken,
      ...(idToken ? { idToken } : {}),
      ...(accountId ? { accountId } : {}),
      ...(lastRefresh ? { lastRefresh } : {}),
      authPath,
    },
  };
}

export function codexOAuthCredentialsNeedRefresh(
  credentials: CodexOAuthCredentials,
  now = new Date(),
): boolean {
  return (
    !credentials.lastRefresh || now.getTime() - credentials.lastRefresh.getTime() > REFRESH_AFTER_MS
  );
}

export async function refreshCodexOAuthCredentials(
  credentials: CodexOAuthCredentials,
  options: CodexAuthStoreOptions & { readonly timeoutMs: number },
): Promise<CodexAuthResult<CodexOAuthCredentials>> {
  if (!credentials.refreshToken) {
    return {
      ok: false,
      code: "oauth_refresh_missing",
      message: "Codex OAuth refresh token is missing.",
      hint: "Run `codex` to log in again.",
    };
  }

  const httpClient = options.httpClient ?? defaultCodexAuthHttpClient;
  const response = await httpClient({
    url: options.refreshUrl ?? CODEX_OAUTH_REFRESH_URL,
    method: "POST",
    timeoutMs: options.timeoutMs,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      scope: "openid profile email",
    }),
  });

  if (response.status !== 200) {
    return refreshFailure(response);
  }

  const parsed = parseJsonRecord(response.body);
  if (parsed.ok === false) {
    return {
      ok: false,
      code: "oauth_refresh_failed",
      message: "Codex OAuth refresh returned invalid JSON.",
      hint: "Run `codex` to log in again.",
    };
  }

  const accessToken = stringValue(parsed.value.access_token) ?? credentials.accessToken;
  const refreshToken = stringValue(parsed.value.refresh_token) ?? credentials.refreshToken;
  const idToken = stringValue(parsed.value.id_token) ?? credentials.idToken;
  const refreshed: CodexOAuthCredentials = {
    accessToken,
    refreshToken,
    ...(idToken ? { idToken } : {}),
    ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
    lastRefresh: options.now ?? new Date(),
    authPath: credentials.authPath,
  };

  const saved = await saveCodexOAuthCredentials(refreshed);
  if (saved.ok === false) {
    return saved;
  }

  return { ok: true, value: refreshed };
}

async function saveCodexOAuthCredentials(
  credentials: CodexOAuthCredentials,
): Promise<CodexAuthResult<void>> {
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(credentials.authPath, "utf8");
    const parsed = parseJsonRecord(raw);
    if (parsed.ok) {
      existing = parsed.value;
    }
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      return {
        ok: false,
        code: "auth_write_failed",
        message: errorMessage(error),
      };
    }
  }

  existing.tokens = {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    ...(credentials.idToken ? { id_token: credentials.idToken } : {}),
    ...(credentials.accountId ? { account_id: credentials.accountId } : {}),
  };
  existing.last_refresh = (credentials.lastRefresh ?? new Date()).toISOString();

  try {
    await mkdir(dirname(credentials.authPath), { recursive: true });
    const tempPath = `${credentials.authPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, credentials.authPath);
    await chmod(credentials.authPath, 0o600);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      code: "auth_write_failed",
      message: errorMessage(error),
    };
  }
}

function refreshFailure(response: CodexAuthHttpResponse): CodexAuthResult<CodexOAuthCredentials> {
  const parsed = parseJsonRecord(response.body);
  const code = parsed.ok
    ? (stringValue(parsed.value.error) ??
      (isRecord(parsed.value.error) ? stringValue(parsed.value.error.code) : undefined) ??
      stringValue(parsed.value.code))
    : undefined;
  const normalizedCode = code?.toLowerCase();
  if (
    response.status === 401 ||
    normalizedCode === "refresh_token_expired" ||
    normalizedCode === "refresh_token_reused" ||
    normalizedCode === "invalid_grant" ||
    normalizedCode === "refresh_token_invalidated"
  ) {
    return {
      ok: false,
      code: "oauth_refresh_failed",
      message: "Codex OAuth refresh token is no longer valid.",
      hint: "Run `codex` to log in again.",
    };
  }

  return {
    ok: false,
    code: "oauth_refresh_failed",
    message: `Codex OAuth refresh failed with HTTP ${response.status}.`,
    hint: "Run `codex` to log in again if this keeps happening.",
  };
}

function codexAuthPath(options: Pick<CodexAuthStoreOptions, "env" | "homeDir">): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return join(env.CODEX_HOME ?? join(home, ".codex"), "auth.json");
}

async function defaultCodexAuthHttpClient(
  request: CodexAuthHttpRequest,
): Promise<CodexAuthHttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  timeout.unref();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
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

function parseJsonRecord(raw: string): CodexAuthResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Codex auth or API JSON could not be parsed.",
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Codex auth or API JSON must be an object.",
    };
  }
  return { ok: true, value: parsed };
}

function dateValue(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
