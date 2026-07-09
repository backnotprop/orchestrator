import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import type { ProviderLimitAccount, ProviderLimitSnapshot, ProviderLimitWindow } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

export function copilotApiLimitSnapshot(input: {
  response: unknown;
  now: Date;
}): ProviderLimitSnapshot {
  const parsed = parseCopilotUserResponse(input.response, input.now);
  if (!parsed.ok) {
    return unavailableProviderLimitSnapshot({
      provider: "copilot",
      now: input.now,
      code: parsed.code,
      message: parsed.message,
    });
  }

  if (parsed.value.windows.length > 0) {
    return {
      provider: "copilot",
      status: "available",
      source: "copilot-api",
      confidence: "exact",
      ...(parsed.value.account ? { account: parsed.value.account } : {}),
      windows: parsed.value.windows,
      updatedAt: input.now.toISOString(),
    };
  }

  if (parsed.value.account) {
    return {
      provider: "copilot",
      status: "partial",
      source: "copilot-api",
      confidence: "exact",
      account: parsed.value.account,
      windows: [],
      updatedAt: input.now.toISOString(),
    };
  }

  return unavailableProviderLimitSnapshot({
    provider: "copilot",
    now: input.now,
    code: "invalid_provider_response",
    message: "GitHub Copilot usage API did not include account or quota data.",
  });
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

type ParsedCopilotUserResponse = {
  readonly account?: ProviderLimitAccount;
  readonly windows: ProviderLimitWindow[];
};

function parseCopilotUserResponse(
  value: unknown,
  now: Date,
): ParseResult<ParsedCopilotUserResponse> {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "GitHub Copilot usage API returned an invalid response.",
    };
  }

  const account = parseAccount(value);
  const quotaSnapshots = recordValue(value.quota_snapshots ?? value.quotaSnapshots);
  const topLevelReset = resetMillis(
    value.quota_reset_date_utc ??
      value.quotaResetDateUtc ??
      value.quota_reset_date ??
      value.quotaResetDate,
  );
  const premium = parseQuotaWindow({
    id: "premium",
    label: "Premium",
    value: quotaSnapshots?.premium_interactions ?? quotaSnapshots?.premiumInteractions,
    fallbackResetMillis: topLevelReset,
    now,
  });
  const chat = parseQuotaWindow({
    id: "chat",
    label: "Chat",
    value: quotaSnapshots?.chat,
    fallbackResetMillis: topLevelReset,
    now,
  });
  const completions = parseQuotaWindow({
    id: "completions",
    label: "Completions",
    value: quotaSnapshots?.completions,
    fallbackResetMillis: topLevelReset,
    now,
  });

  return {
    ok: true,
    value: {
      ...(account ? { account } : {}),
      windows: orderedWindows({ premium, chat, completions }),
    },
  };
}

function parseAccount(value: UnknownRecord): ProviderLimitAccount | undefined {
  const username = stringValue(value.login);
  const plan = stringValue(value.copilot_plan ?? value.copilotPlan);
  if (!username && !plan) {
    return undefined;
  }

  return {
    ...(username ? { username } : {}),
    ...(plan ? { plan } : {}),
    loginMethod: "github",
  };
}

function orderedWindows(input: {
  readonly premium?: ProviderLimitWindow;
  readonly chat?: ProviderLimitWindow;
  readonly completions?: ProviderLimitWindow;
}): ProviderLimitWindow[] {
  const windows: ProviderLimitWindow[] = [];
  if (input.premium) {
    windows.push(input.premium);
  } else if (input.completions) {
    windows.push(input.completions);
  }
  if (input.chat) {
    windows.push(input.chat);
  }
  if (input.premium && input.completions) {
    windows.push(input.completions);
  }
  return windows;
}

function parseQuotaWindow(input: {
  readonly id: string;
  readonly label: string;
  readonly value: unknown;
  readonly fallbackResetMillis?: number;
  readonly now: Date;
}): ProviderLimitWindow | undefined {
  const value = recordValue(input.value);
  if (!value) {
    return undefined;
  }

  const unlimited = booleanValue(value.unlimited) ?? false;
  const remainingCount = flexibleNumber(
    value.remaining ?? value.quota_remaining ?? value.quotaRemaining,
  );
  const entitlement = flexibleNumber(
    value.entitlement ??
      value.monthly_quota ??
      value.monthlyQuota ??
      value.limited_user_quota ??
      value.limitedUserQuota ??
      value.limit,
  );
  const rawRemainingPercent = flexibleNumber(
    value.percent_remaining ??
      value.percentRemaining ??
      value.remaining_percent ??
      value.remainingPercent,
  );

  if (isZeroPlaceholder({ entitlement, remainingCount, rawRemainingPercent, unlimited })) {
    return undefined;
  }

  const remainingPercent = remainingPercentValue({
    unlimited,
    remainingCount,
    entitlement,
    rawRemainingPercent,
  });
  if (remainingPercent === undefined) {
    return undefined;
  }

  const window: ProviderLimitWindow = {
    id: input.id,
    label: input.label,
    usedPercent: roundPercent(100 - remainingPercent),
    remainingPercent: roundPercent(remainingPercent),
  };

  if (!unlimited) {
    const reset = firstResetMillis([
      value.quota_reset_at,
      value.quotaResetAt,
      value.reset_at,
      value.resetAt,
      input.fallbackResetMillis,
    ]);
    if (reset !== undefined) {
      return {
        ...window,
        resetsAt: new Date(reset).toISOString(),
        resetDescription: resetDescription(reset, input.now),
      };
    }
  }

  return window;
}

function remainingPercentValue(input: {
  readonly unlimited: boolean;
  readonly remainingCount?: number;
  readonly entitlement?: number;
  readonly rawRemainingPercent?: number;
}): number | undefined {
  if (input.unlimited) {
    return 100;
  }
  if (input.rawRemainingPercent !== undefined) {
    return clampPercent(input.rawRemainingPercent);
  }
  if (
    input.remainingCount !== undefined &&
    input.entitlement !== undefined &&
    input.entitlement > 0
  ) {
    return clampPercent((input.remainingCount / input.entitlement) * 100);
  }
  return undefined;
}

function isZeroPlaceholder(input: {
  readonly entitlement?: number;
  readonly remainingCount?: number;
  readonly rawRemainingPercent?: number;
  readonly unlimited: boolean;
}): boolean {
  return !input.unlimited && input.entitlement === 0 && input.remainingCount === 0;
}

function firstResetMillis(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const parsed = resetMillis(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function resetMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) {
      return undefined;
    }
    return value > 9_999_999_999 ? value : value * 1000;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return resetMillis(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resetDescription(resetMillisValue: number, now: Date): string {
  const deltaMs = resetMillisValue - now.getTime();
  if (deltaMs <= 0) {
    return "now";
  }
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

function recordValue(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function flexibleNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function roundPercent(value: number): number {
  return Math.round(clampPercent(value) * 10) / 10;
}
