import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import type {
  ProviderCreditsSnapshot,
  ProviderLimitAccount,
  ProviderLimitSnapshot,
  ProviderLimitWindow,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;

type ClaudeOAuthCredentialsForSnapshot = {
  readonly rateLimitTier?: string;
  readonly subscriptionType?: string;
};

export function claudeOAuthLimitSnapshot(input: {
  readonly response: unknown;
  readonly credentials: ClaudeOAuthCredentialsForSnapshot;
  readonly now: Date;
}): ProviderLimitSnapshot {
  const parsed = parseClaudeOAuthUsage(input.response, input.now);
  if (!parsed.ok) {
    return unavailableProviderLimitSnapshot({
      provider: "claude",
      now: input.now,
      code: parsed.code,
      message: parsed.message,
    });
  }

  const account = accountFromCredentials(input.credentials);
  if (parsed.value.windows.length > 0 || parsed.value.credits) {
    return {
      provider: "claude",
      status: "available",
      source: "claude-oauth",
      confidence: "exact",
      ...(account ? { account } : {}),
      windows: parsed.value.windows,
      ...(parsed.value.credits ? { credits: parsed.value.credits } : {}),
      updatedAt: input.now.toISOString(),
    };
  }

  return unavailableProviderLimitSnapshot({
    provider: "claude",
    now: input.now,
    code: "invalid_provider_response",
    message: "Claude OAuth usage API did not include usable limit data.",
  });
}

export function claudeCliAuthStatusLimitSnapshot(input: {
  readonly status: unknown;
  readonly now: Date;
}): ProviderLimitSnapshot {
  const parsed = parseClaudeAuthStatus(input.status);
  if (!parsed.ok) {
    return unavailableProviderLimitSnapshot({
      provider: "claude",
      now: input.now,
      code: parsed.code,
      message: parsed.message,
    });
  }

  return {
    provider: "claude",
    status: "partial",
    source: "claude-cli",
    confidence: "exact",
    account: parsed.value,
    windows: [],
    updatedAt: input.now.toISOString(),
    error: {
      code: "usage_unavailable",
      message: "Claude CLI auth is available, but no OAuth usage token was available.",
    },
  };
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

type ParsedClaudeOAuthUsage = {
  readonly windows: ProviderLimitWindow[];
  readonly credits?: ProviderCreditsSnapshot;
};

function parseClaudeOAuthUsage(value: unknown, now: Date): ParseResult<ParsedClaudeOAuthUsage> {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Claude OAuth usage API returned an invalid response.",
    };
  }

  const session = parseUsageWindow("session", "Session", value.five_hour ?? value.fiveHour, {
    now,
    windowMinutes: 5 * 60,
  });
  const weekly = parseUsageWindow("weekly", "Week", value.seven_day ?? value.sevenDay, {
    now,
    windowMinutes: 7 * 24 * 60,
  });
  const windows = orderedPrimaryWindows({ session, weekly });

  for (const extra of extraWindows(value, now)) {
    windows.push(extra);
  }

  const credits = parseExtraUsageCredits(value.extra_usage ?? value.extraUsage);
  return {
    ok: true,
    value: {
      windows,
      ...(credits ? { credits } : {}),
    },
  };
}

function orderedPrimaryWindows(input: {
  readonly session?: ProviderLimitWindow;
  readonly weekly?: ProviderLimitWindow;
}): ProviderLimitWindow[] {
  if (input.session && input.weekly) {
    return [input.session, input.weekly];
  }
  if (input.session) {
    return [input.session];
  }
  if (input.weekly) {
    return [input.weekly];
  }
  return [];
}

function extraWindows(value: UnknownRecord, now: Date): ProviderLimitWindow[] {
  const extras: ProviderLimitWindow[] = [];
  for (const candidate of [
    parseUsageWindow(
      "oauth-apps",
      "OAuth apps",
      value.seven_day_oauth_apps ?? value.sevenDayOAuthApps,
      { now, windowMinutes: 7 * 24 * 60 },
    ),
    parseUsageWindow(
      "sonnet-weekly",
      "Sonnet week",
      value.seven_day_sonnet ?? value.sevenDaySonnet,
      { now, windowMinutes: 7 * 24 * 60 },
    ),
    parseUsageWindow("opus-weekly", "Opus week", value.seven_day_opus ?? value.sevenDayOpus, {
      now,
      windowMinutes: 7 * 24 * 60,
    }),
    parseUsageWindow("daily-routines", "Daily Routines", routinesWindowValue(value), {
      now,
      windowMinutes: 7 * 24 * 60,
    }),
  ]) {
    if (candidate) {
      extras.push(candidate);
    }
  }

  for (const scoped of parseScopedLimitWindows(value.limits, now)) {
    extras.push(scoped);
  }
  return extras;
}

function routinesWindowValue(value: UnknownRecord): unknown {
  for (const key of [
    "seven_day_routines",
    "seven_day_claude_routines",
    "claude_routines",
    "routines",
    "routine",
    "seven_day_cowork",
    "cowork",
  ]) {
    if (Object.hasOwn(value, key)) {
      return value[key];
    }
  }
  return undefined;
}

function parseUsageWindow(
  id: string,
  label: string,
  value: unknown,
  options: { readonly now: Date; readonly windowMinutes: number },
): ProviderLimitWindow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawUsedPercent = flexibleNumber(value.utilization ?? value.percent);
  if (rawUsedPercent === undefined) {
    return undefined;
  }
  const usedPercent = roundPercent(rawUsedPercent);
  const window: ProviderLimitWindow = {
    id,
    label,
    usedPercent,
    remainingPercent: roundPercent(100 - usedPercent),
  };
  const resetMillisValue = dateMillis(value.resets_at ?? value.resetsAt);
  if (resetMillisValue === undefined) {
    return window;
  }
  return {
    ...window,
    resetsAt: new Date(resetMillisValue).toISOString(),
    resetDescription: resetDescription(resetMillisValue, options.now),
  };
}

function parseScopedLimitWindows(value: unknown, now: Date): ProviderLimitWindow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const windows: ProviderLimitWindow[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    const percent = flexibleNumber(item.percent);
    const model = modelScope(item.scope);
    if (percent === undefined || !model.name) {
      continue;
    }
    const usedPercent = roundPercent(percent);
    const id = `scoped:${model.id ?? model.name.toLowerCase().replaceAll(/\s+/g, "-")}:${index}`;
    const window: ProviderLimitWindow = {
      id,
      label: `${model.name} week`,
      usedPercent,
      remainingPercent: roundPercent(100 - usedPercent),
    };
    const resetMillisValue = dateMillis(item.resets_at ?? item.resetsAt);
    windows.push(
      resetMillisValue === undefined
        ? window
        : {
            ...window,
            resetsAt: new Date(resetMillisValue).toISOString(),
            resetDescription: resetDescription(resetMillisValue, now),
          },
    );
  }
  return windows;
}

function modelScope(value: unknown): { readonly id?: string; readonly name?: string } {
  if (!isRecord(value)) {
    return {};
  }
  const model = recordValue(value.model);
  if (!model) {
    return {};
  }
  const id = stringValue(model.id);
  const name = stringValue(model.display_name ?? model.displayName);
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
}

function parseExtraUsageCredits(value: unknown): ProviderCreditsSnapshot | undefined {
  if (!isRecord(value) || (value.is_enabled ?? value.isEnabled) !== true) {
    return undefined;
  }
  const rawUsed = flexibleNumber(value.used_credits ?? value.usedCredits);
  const rawLimit = flexibleNumber(value.monthly_limit ?? value.monthlyLimit);
  if (rawUsed === undefined || rawLimit === undefined) {
    return undefined;
  }
  const used = rawUsed / 100;
  const limit = rawLimit / 100;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    unit: stringValue(value.currency) ?? "USD",
  };
}

function parseClaudeAuthStatus(value: unknown): ParseResult<ProviderLimitAccount> {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Claude CLI auth status returned an invalid response.",
    };
  }
  if (value.loggedIn === false) {
    return {
      ok: false,
      code: "auth_missing",
      message: "Claude CLI is not logged in.",
    };
  }

  const email = stringValue(value.email);
  const organization = stringValue(value.orgName ?? value.organization);
  const plan = stringValue(value.subscriptionType ?? value.plan);
  const loginMethod = stringValue(value.authMethod);
  const id = stringValue(value.orgId);
  if (!email && !organization && !plan && !loginMethod && !id) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Claude CLI auth status did not include account data.",
    };
  }

  return {
    ok: true,
    value: {
      ...(id ? { id } : {}),
      ...(email ? { email } : {}),
      ...(organization ? { organization } : {}),
      ...(plan ? { plan } : {}),
      ...(loginMethod ? { loginMethod } : {}),
    },
  };
}

function accountFromCredentials(
  credentials: ClaudeOAuthCredentialsForSnapshot,
): ProviderLimitAccount | undefined {
  const plan = planLabel(credentials.subscriptionType ?? credentials.rateLimitTier);
  if (!plan) {
    return { loginMethod: "claude-oauth" };
  }
  return {
    plan,
    loginMethod: "claude-oauth",
  };
}

function planLabel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized.includes("max_20x")) {
    return "Max 20x";
  }
  if (normalized.includes("max_5x")) {
    return "Max 5x";
  }
  if (normalized.includes("max")) {
    return "max";
  }
  if (normalized.includes("enterprise")) {
    return "enterprise";
  }
  if (normalized.includes("team")) {
    return "team";
  }
  if (normalized.includes("pro")) {
    return "pro";
  }
  return value;
}

function dateMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) {
      return undefined;
    }
    return value > 9_999_999_999 ? value : value * 1000;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return dateMillis(numeric);
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
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function roundPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}
