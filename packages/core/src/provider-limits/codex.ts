import { createCodexAppServerLimitSource, type CodexLimitSource } from "./codex-app-server.ts";
import { createCodexOAuthLimitSource } from "./codex-oauth.ts";
import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import type {
  ProviderLimitReader,
  ProviderLimitReaderInput,
  ProviderLimitSnapshot,
} from "./types.ts";

export type CreateCodexLimitReaderOptions = {
  readonly sources?: readonly CodexLimitSource[];
};

export function createCodexLimitReader(
  options: CreateCodexLimitReaderOptions = {},
): ProviderLimitReader {
  return {
    provider: "codex",
    async read(input) {
      return await readCodexProviderLimit(input, options.sources ?? defaultCodexLimitSources());
    },
  };
}

function defaultCodexLimitSources(): readonly CodexLimitSource[] {
  return [createCodexAppServerLimitSource(), createCodexOAuthLimitSource()];
}

async function readCodexProviderLimit(
  input: ProviderLimitReaderInput,
  sources: readonly CodexLimitSource[],
): Promise<ProviderLimitSnapshot> {
  const now = input.now ?? new Date();
  let best: ProviderLimitSnapshot | undefined;

  for (const source of sources) {
    const snapshot = await readSource(source, input, now);
    if (snapshot.status === "available") {
      return snapshot;
    }
    best = betterCodexSnapshot(best, snapshot);
  }

  return (
    best ??
    unavailableProviderLimitSnapshot({
      provider: "codex",
      now,
      code: "no_limit_sources",
      message: "No Codex provider limit readers are configured.",
    })
  );
}

async function readSource(
  source: CodexLimitSource,
  input: ProviderLimitReaderInput,
  now: Date,
): Promise<ProviderLimitSnapshot> {
  try {
    return await source.read(input);
  } catch (error: unknown) {
    return unavailableProviderLimitSnapshot({
      provider: "codex",
      now,
      code: "reader_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function betterCodexSnapshot(
  current: ProviderLimitSnapshot | undefined,
  next: ProviderLimitSnapshot,
): ProviderLimitSnapshot {
  if (!current) {
    return next;
  }
  if (next.status === "partial" && current.status === "unavailable") {
    return next;
  }
  if (next.status === current.status && isMoreActionableCodexError(next, current)) {
    return next;
  }
  return current;
}

function isMoreActionableCodexError(
  next: ProviderLimitSnapshot,
  current: ProviderLimitSnapshot,
): boolean {
  return errorPriority(next.error?.code) > errorPriority(current.error?.code);
}

function errorPriority(code: string | undefined): number {
  switch (code) {
    case "auth_missing":
    case "auth_failed":
    case "oauth_tokens_missing":
    case "oauth_refresh_missing":
    case "oauth_refresh_failed":
      return 3;
    case "unsupported_codex_app_server":
    case "not_openai_account":
      return 2;
    case "timeout":
    case "provider_unavailable":
    case "codex_app_server_unavailable":
      return 1;
    default:
      return 0;
  }
}
