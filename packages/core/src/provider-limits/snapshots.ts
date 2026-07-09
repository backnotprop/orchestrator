import type { ProviderLimitProvider, ProviderLimitSnapshot } from "./types.ts";

export function unavailableProviderLimitSnapshot(input: {
  provider: ProviderLimitProvider;
  now: Date;
  code: string;
  message: string;
  hint?: string;
}): ProviderLimitSnapshot {
  return {
    provider: input.provider,
    status: "unavailable",
    confidence: "unknown",
    windows: [],
    updatedAt: input.now.toISOString(),
    error: {
      code: input.code,
      message: redactProviderLimitError(input.message),
      ...(input.hint ? { hint: input.hint } : {}),
    },
  };
}

function redactProviderLimitError(message: string): string {
  return message
    .replace(
      /\b(Bearer|token|access_token|refresh_token|api[_-]?key)\s+[\w./+=:-]+/gi,
      "$1 [redacted]",
    )
    .replace(/(access_token|refresh_token|api[_-]?key|token)=([^&\s]+)/gi, "$1=[redacted]");
}
