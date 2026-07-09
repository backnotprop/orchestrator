import { createClaudeLimitReader } from "./claude.ts";
import { createCodexLimitReader } from "./codex.ts";
import { createCopilotLimitReader } from "./copilot.ts";
import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import {
  BUILT_IN_PROVIDER_LIMIT_PROVIDERS,
  type BuiltInProviderLimitProvider,
  type ProviderLimitProvider,
  type ProviderLimitReader,
  type ProviderLimitSnapshot,
  type ProviderLimitsReport,
} from "./types.ts";

export const DEFAULT_PROVIDER_LIMIT_TIMEOUT_MS = 5_000;

export type ReadProviderLimitsInput = {
  providers?: readonly ProviderLimitProvider[];
  workspaceRoot: string;
  orchestratorDir?: string;
  timeoutMs?: number;
  now?: Date;
  readers?: readonly ProviderLimitReader[];
};

export function defaultProviderLimitReaders(): ProviderLimitReader[] {
  return [createCodexLimitReader(), createCopilotLimitReader(), createClaudeLimitReader()];
}

export async function readProviderLimits(
  input: ReadProviderLimitsInput,
): Promise<ProviderLimitsReport> {
  const now = input.now ?? new Date();
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROVIDER_LIMIT_TIMEOUT_MS;
  const readers = input.readers ?? defaultProviderLimitReaders();
  const providers = input.providers ?? BUILT_IN_PROVIDER_LIMIT_PROVIDERS;

  const snapshots = await Promise.all(
    providers.map((provider) =>
      readOneProviderLimit({
        provider,
        workspaceRoot: input.workspaceRoot,
        ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
        timeoutMs,
        now,
        readers,
      }),
    ),
  );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    providers: snapshots,
  };
}

export function isBuiltInProviderLimitProvider(
  provider: string,
): provider is BuiltInProviderLimitProvider {
  return (BUILT_IN_PROVIDER_LIMIT_PROVIDERS as readonly string[]).includes(provider);
}

async function readOneProviderLimit(input: {
  provider: ProviderLimitProvider;
  workspaceRoot: string;
  orchestratorDir?: string;
  timeoutMs: number;
  now: Date;
  readers: readonly ProviderLimitReader[];
}): Promise<ProviderLimitSnapshot> {
  const reader = input.readers.find((candidate) => candidate.provider === input.provider);
  if (!reader) {
    return unavailableProviderLimitSnapshot({
      provider: input.provider,
      now: input.now,
      code: "unsupported_provider",
      message: `Provider "${input.provider}" is not supported by orchestrator limits.`,
      hint: "Use codex, copilot, or claude.",
    });
  }

  try {
    return await withTimeout(
      reader.read({
        provider: input.provider,
        workspaceRoot: input.workspaceRoot,
        ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
        timeoutMs: input.timeoutMs,
        now: input.now,
      }),
      input.timeoutMs,
      input.provider,
    );
  } catch (error) {
    return unavailableProviderLimitSnapshot({
      provider: input.provider,
      now: input.now,
      code: error instanceof ProviderLimitTimeoutError ? "timeout" : "reader_failed",
      message:
        error instanceof ProviderLimitTimeoutError
          ? `Timed out reading ${input.provider} provider limits after ${input.timeoutMs}ms.`
          : errorMessage(error),
    });
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  provider: ProviderLimitProvider,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new ProviderLimitTimeoutError(provider, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class ProviderLimitTimeoutError extends Error {
  readonly provider: ProviderLimitProvider;
  readonly timeoutMs: number;

  constructor(provider: ProviderLimitProvider, timeoutMs: number) {
    super(`Timed out reading ${provider} provider limits after ${timeoutMs}ms.`);
    this.name = "ProviderLimitTimeoutError";
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
