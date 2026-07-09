import {
  CodexAppServerControllerError,
  withCodexAppServerConnection,
} from "../tasks/executors/protocol/codex-app-server-controller.ts";
import { JsonRpcWebSocketUnixClientError } from "../tasks/executors/protocol/json-rpc-websocket-unix.ts";
import { codexAppServerLimitSnapshot } from "./codex-mapping.ts";
import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import type { ProviderLimitReaderInput, ProviderLimitSnapshot } from "./types.ts";

export type CodexLimitSource = {
  readonly source: "codex-app-server" | "codex-oauth";
  read(input: ProviderLimitReaderInput): Promise<ProviderLimitSnapshot>;
};

export type CodexAppServerLimitSourceOptions = {
  readonly executable?: string;
  readonly env?: Record<string, string | undefined>;
  readonly readAccount?: (input: ProviderLimitReaderInput) => Promise<unknown>;
  readonly readRateLimits?: (input: ProviderLimitReaderInput) => Promise<unknown>;
};

export function createCodexAppServerLimitSource(
  options: CodexAppServerLimitSourceOptions = {},
): CodexLimitSource {
  return {
    source: "codex-app-server",
    async read(input) {
      const now = input.now ?? new Date();
      try {
        if (options.readAccount && options.readRateLimits) {
          const accountResponse = await options.readAccount(input);
          const early = codexAppServerLimitSnapshot({
            accountResponse,
            rateLimitsResponse: {},
            now,
          });
          if (isTerminalAccountSnapshot(early)) {
            return early;
          }
          return codexAppServerLimitSnapshot({
            accountResponse,
            rateLimitsResponse: await options.readRateLimits(input),
            now,
          });
        }

        return await readCodexAppServerLimits(input, options, now);
      } catch (error: unknown) {
        return unavailableProviderLimitSnapshot({
          provider: "codex",
          now,
          ...classifyCodexAppServerError(error),
        });
      }
    },
  };
}

async function readCodexAppServerLimits(
  input: ProviderLimitReaderInput,
  options: Pick<CodexAppServerLimitSourceOptions, "executable" | "env">,
  now: Date,
): Promise<ProviderLimitSnapshot> {
  const requestTimeoutMs = Math.max(500, Math.floor(input.timeoutMs / 3));
  return await withCodexAppServerConnection(
    {
      cwd: input.workspaceRoot,
      ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
      ...(options.executable ? { executable: options.executable } : {}),
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: input.timeoutMs,
      requestTimeoutMs,
    },
    async (connection) => {
      const accountResponse = await connection.request(
        "account/read",
        { refreshToken: false },
        {
          timeoutMs: requestTimeoutMs,
        },
      );
      const early = codexAppServerLimitSnapshot({
        accountResponse,
        rateLimitsResponse: {},
        now,
      });
      if (isTerminalAccountSnapshot(early)) {
        return early;
      }
      const rateLimitsResponse = await connection.request("account/rateLimits/read", undefined, {
        timeoutMs: requestTimeoutMs,
      });
      return codexAppServerLimitSnapshot({
        accountResponse,
        rateLimitsResponse,
        now,
      });
    },
  );
}

function isTerminalAccountSnapshot(snapshot: ProviderLimitSnapshot): boolean {
  return (
    snapshot.status === "unavailable" &&
    (snapshot.error?.code === "auth_missing" || snapshot.error?.code === "not_openai_account")
  );
}

function classifyCodexAppServerError(error: unknown): {
  code: string;
  message: string;
  hint?: string;
} {
  const message = errorMessage(error);
  if (error instanceof CodexAppServerControllerError) {
    if (error.reason === "unsupported") {
      return {
        code: "codex_app_server_unavailable",
        message,
      };
    }
    return {
      code: "codex_app_server_unavailable",
      message,
      hint: "Check that Codex app-server is installed and can start.",
    };
  }

  if (error instanceof JsonRpcWebSocketUnixClientError) {
    if (error.code === "request_timeout") {
      return {
        code: "timeout",
        message,
      };
    }
    if (isUnsupportedMethodError(error)) {
      return {
        code: "unsupported_codex_app_server",
        message,
        hint: "Update Codex to a version that supports account/rateLimits/read.",
      };
    }
    if (isAuthError(message)) {
      return {
        code: "auth_missing",
        message,
        hint: "Run `codex` and sign in with ChatGPT.",
      };
    }
    return {
      code: "codex_app_server_unavailable",
      message,
    };
  }

  if (isAuthError(message)) {
    return {
      code: "auth_missing",
      message,
      hint: "Run `codex` and sign in with ChatGPT.",
    };
  }

  return {
    code: "codex_app_server_unavailable",
    message,
  };
}

function isUnsupportedMethodError(error: JsonRpcWebSocketUnixClientError): boolean {
  if (!isRecord(error.details)) {
    return /method not found|unsupported/i.test(error.message);
  }
  const code = typeof error.details.code === "number" ? error.details.code : undefined;
  const message = typeof error.details.message === "string" ? error.details.message : error.message;
  return code === -32601 || /method not found|unsupported/i.test(message);
}

function isAuthError(message: string): boolean {
  return /auth|authentication|required|unauthorized|forbidden/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
