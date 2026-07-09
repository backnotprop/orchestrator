import { unavailableProviderLimitSnapshot } from "./snapshots.ts";
import type {
  ProviderCreditsSnapshot,
  ProviderLimitAccount,
  ProviderLimitSnapshot,
  ProviderLimitWindow,
  ProviderResetCreditsSnapshot,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;

export function codexAppServerLimitSnapshot(input: {
  accountResponse: unknown;
  rateLimitsResponse: unknown;
  now: Date;
}): ProviderLimitSnapshot {
  const account = parseAppServerAccountResponse(input.accountResponse);
  if (!account.ok) {
    return codexUnavailable(input.now, account.code, account.message, account.hint);
  }

  if (account.value.account?.loginMethod === "apiKey") {
    return codexUnavailable(
      input.now,
      "auth_missing",
      "Codex is authenticated with an API key, but ChatGPT authentication is required to read Codex account limits.",
      "Run `codex` and sign in with ChatGPT.",
    );
  }

  if (!account.value.account && account.value.requiresOpenaiAuth) {
    return codexUnavailable(
      input.now,
      "auth_missing",
      "Codex ChatGPT auth is missing.",
      "Run `codex` to log in.",
    );
  }

  if (!account.value.account && !account.value.requiresOpenaiAuth) {
    return codexUnavailable(
      input.now,
      "not_openai_account",
      "Codex is not currently using an OpenAI account that exposes Codex limits.",
    );
  }

  const rateLimits = parseAppServerRateLimitsResponse(input.rateLimitsResponse);
  if (!rateLimits.ok) {
    return codexUnavailable(input.now, rateLimits.code, rateLimits.message, rateLimits.hint);
  }

  const windows = appServerWindows(rateLimits.value, input.now);
  const credits = creditsFromSnapshots(
    rateLimits.value.rateLimits.individualLimit,
    rateLimits.value.rateLimits.credits,
    input.now,
  );
  const resetCredits = resetCreditsFromAppServer(rateLimits.value.rateLimitResetCredits);
  const status = windows.length > 0 || credits || resetCredits ? "available" : "partial";

  return {
    provider: "codex",
    status,
    source: "codex-app-server",
    confidence: "exact",
    ...(account.value.account ? { account: account.value.account } : {}),
    windows,
    ...(credits ? { credits } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    updatedAt: input.now.toISOString(),
  };
}

export function codexOAuthLimitSnapshot(input: {
  usageResponse: unknown;
  resetCreditsResponse?: unknown;
  now: Date;
}): ProviderLimitSnapshot {
  const usage = parseOAuthUsageResponse(input.usageResponse);
  if (!usage.ok) {
    return codexUnavailable(input.now, usage.code, usage.message, usage.hint);
  }

  const windows = oauthWindows(usage.value, input.now);
  const credits = creditsFromSnapshots(
    usage.value.individualLimit ?? usage.value.rateLimit?.individualLimit,
    usage.value.credits,
    input.now,
  );
  const resetCredits =
    input.resetCreditsResponse === undefined
      ? undefined
      : resetCreditsFromOAuth(input.resetCreditsResponse, input.now);
  const status = windows.length > 0 || credits || resetCredits ? "available" : "partial";

  return {
    provider: "codex",
    status,
    source: "codex-oauth",
    confidence: "exact",
    account: {
      ...(usage.value.planType ? { plan: usage.value.planType } : {}),
      loginMethod: "chatgpt",
    },
    windows,
    ...(credits ? { credits } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    updatedAt: input.now.toISOString(),
  };
}

function codexUnavailable(
  now: Date,
  code: string,
  message: string,
  hint?: string,
): ProviderLimitSnapshot {
  return unavailableProviderLimitSnapshot({
    provider: "codex",
    now,
    code,
    message,
    ...(hint ? { hint } : {}),
  });
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint?: string;
    };

type AppServerAccountResponse = {
  readonly account?: ProviderLimitAccount;
  readonly requiresOpenaiAuth: boolean;
};

type AppServerRateLimitsResponse = {
  readonly rateLimits: RateLimitSnapshot;
  readonly rateLimitsByLimitId: ReadonlyMap<string, RateLimitSnapshot>;
  readonly rateLimitResetCredits?: { readonly availableCount?: number };
};

type RateLimitSnapshot = {
  readonly limitId?: string;
  readonly limitName?: string;
  readonly primary?: RateLimitWindow;
  readonly secondary?: RateLimitWindow;
  readonly credits?: CreditDetails;
  readonly individualLimit?: IndividualLimit;
  readonly planType?: string;
};

type RateLimitWindow = {
  readonly usedPercent: number;
  readonly windowDurationMins?: number;
  readonly resetsAt?: number;
};

type CreditDetails = {
  readonly balance?: number;
  readonly hasCredits?: boolean;
  readonly unlimited?: boolean;
};

type IndividualLimit = {
  readonly limit?: number;
  readonly used?: number;
  readonly remainingPercent?: number;
  readonly resetsAt?: number;
};

type OAuthUsageResponse = {
  readonly planType?: string;
  readonly rateLimit?: OAuthRateLimitDetails;
  readonly additionalRateLimits: readonly OAuthAdditionalRateLimit[];
  readonly credits?: CreditDetails;
  readonly individualLimit?: IndividualLimit;
};

type OAuthRateLimitDetails = {
  readonly primaryWindow?: OAuthRateLimitWindow;
  readonly secondaryWindow?: OAuthRateLimitWindow;
  readonly individualLimit?: IndividualLimit;
};

type OAuthRateLimitWindow = {
  readonly usedPercent: number;
  readonly resetAt?: number;
  readonly limitWindowSeconds?: number;
};

type OAuthAdditionalRateLimit = {
  readonly limitName?: string;
  readonly meteredFeature?: string;
  readonly rateLimit?: OAuthRateLimitDetails;
};

function parseAppServerAccountResponse(value: unknown): ParseResult<AppServerAccountResponse> {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Codex account/read returned an invalid response.",
    };
  }

  const requiresOpenaiAuth = booleanValue(value.requiresOpenaiAuth) ?? false;
  const account = parseAppServerAccount(value.account);
  return {
    ok: true,
    value: {
      requiresOpenaiAuth,
      ...(account ? { account } : {}),
    },
  };
}

function parseAppServerAccount(value: unknown): ProviderLimitAccount | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const loginMethod = stringValue(value.type);
  const email = stringValue(value.email);
  const plan = stringValue(value.planType) ?? stringValue(value.plan);
  const id = stringValue(value.accountId) ?? stringValue(value.id);
  return {
    ...(id ? { id } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(loginMethod ? { loginMethod } : {}),
  };
}

function parseAppServerRateLimitsResponse(
  value: unknown,
): ParseResult<AppServerRateLimitsResponse> {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Codex account/rateLimits/read returned an invalid response.",
    };
  }

  const rateLimits = parseRateLimitSnapshot(value.rateLimits);
  if (!rateLimits) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Codex account/rateLimits/read did not include rateLimits.",
    };
  }

  return {
    ok: true,
    value: {
      rateLimits,
      rateLimitsByLimitId: parseRateLimitsByLimitId(value.rateLimitsByLimitId),
      ...optionalResetCreditsFromRecord(value.rateLimitResetCredits),
    },
  };
}

function parseRateLimitsByLimitId(value: unknown): ReadonlyMap<string, RateLimitSnapshot> {
  const result = new Map<string, RateLimitSnapshot>();
  if (!isRecord(value)) {
    return result;
  }
  for (const [key, rawSnapshot] of Object.entries(value)) {
    const snapshot = parseRateLimitSnapshot(rawSnapshot);
    if (snapshot) {
      result.set(key, snapshot);
    }
  }
  return result;
}

function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const primary = parseRateLimitWindow(value.primary);
  const secondary = parseRateLimitWindow(value.secondary);
  const credits = parseCreditDetails(value.credits);
  const individualLimit = parseIndividualLimit(value.individualLimit ?? value.individual_limit);
  return {
    ...optionalString("limitId", value.limitId ?? value.limit_id),
    ...optionalString("limitName", value.limitName ?? value.limit_name),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
    ...(individualLimit ? { individualLimit } : {}),
    ...optionalString("planType", value.planType ?? value.plan_type),
  };
}

function parseRateLimitWindow(value: unknown): RateLimitWindow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usedPercent = numberValue(value.usedPercent ?? value.used_percent);
  if (usedPercent === undefined) {
    return undefined;
  }
  return {
    usedPercent: clampPercent(usedPercent),
    ...optionalNumber("windowDurationMins", value.windowDurationMins ?? value.window_duration_mins),
    ...optionalNumber("resetsAt", value.resetsAt ?? value.resets_at),
  };
}

function parseOAuthUsageResponse(value: unknown): ParseResult<OAuthUsageResponse> {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Codex usage API returned an invalid response.",
    };
  }

  const rateLimit = parseOAuthRateLimitDetails(value.rate_limit ?? value.rateLimit);
  const additionalRateLimits = parseOAuthAdditionalRateLimits(value.additional_rate_limits);
  const credits = parseCreditDetails(value.credits);
  const individualLimit = parseIndividualLimit(value.individual_limit ?? value.individualLimit);

  if (!rateLimit && additionalRateLimits.length === 0 && !credits && !individualLimit) {
    return {
      ok: false,
      code: "invalid_provider_response",
      message: "Codex usage API response did not include usable limit data.",
    };
  }

  return {
    ok: true,
    value: {
      ...optionalString("planType", value.plan_type ?? value.planType),
      ...(rateLimit ? { rateLimit } : {}),
      additionalRateLimits,
      ...(credits ? { credits } : {}),
      ...(individualLimit ? { individualLimit } : {}),
    },
  };
}

function parseOAuthRateLimitDetails(value: unknown): OAuthRateLimitDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const primaryWindow = parseOAuthWindow(value.primary_window ?? value.primaryWindow);
  const secondaryWindow = parseOAuthWindow(value.secondary_window ?? value.secondaryWindow);
  const individualLimit = parseIndividualLimit(value.individual_limit ?? value.individualLimit);
  if (!primaryWindow && !secondaryWindow && !individualLimit) {
    return undefined;
  }
  return {
    ...(primaryWindow ? { primaryWindow } : {}),
    ...(secondaryWindow ? { secondaryWindow } : {}),
    ...(individualLimit ? { individualLimit } : {}),
  };
}

function parseOAuthWindow(value: unknown): OAuthRateLimitWindow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usedPercent = numberValue(value.used_percent ?? value.usedPercent);
  if (usedPercent === undefined) {
    return undefined;
  }
  return {
    usedPercent: clampPercent(usedPercent),
    ...optionalNumber("resetAt", value.reset_at ?? value.resetAt),
    ...optionalNumber("limitWindowSeconds", value.limit_window_seconds ?? value.limitWindowSeconds),
  };
}

function parseOAuthAdditionalRateLimits(value: unknown): readonly OAuthAdditionalRateLimit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const rateLimit = parseOAuthRateLimitDetails(item.rate_limit ?? item.rateLimit);
    if (!rateLimit) {
      return [];
    }
    return [
      {
        ...optionalString("limitName", item.limit_name ?? item.limitName),
        ...optionalString("meteredFeature", item.metered_feature ?? item.meteredFeature),
        rateLimit,
      },
    ];
  });
}

function parseCreditDetails(value: unknown): CreditDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const balance = flexibleNumber(value.balance);
  const hasCredits = booleanValue(value.has_credits ?? value.hasCredits);
  const unlimited = booleanValue(value.unlimited);
  if (balance === undefined && hasCredits === undefined && unlimited === undefined) {
    return undefined;
  }
  return {
    ...(balance !== undefined ? { balance } : {}),
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
  };
}

function parseIndividualLimit(value: unknown): IndividualLimit | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const limit = flexibleNumber(value.limit);
  const used = flexibleNumber(value.used);
  const remainingPercent = flexibleNumber(value.remainingPercent ?? value.remaining_percent);
  const resetsAt = flexibleNumber(value.resetsAt ?? value.resets_at);
  if (
    limit === undefined &&
    used === undefined &&
    remainingPercent === undefined &&
    resetsAt === undefined
  ) {
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remainingPercent !== undefined ? { remainingPercent: clampPercent(remainingPercent) } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function appServerWindows(value: AppServerRateLimitsResponse, now: Date): ProviderLimitWindow[] {
  const windows: ProviderLimitWindow[] = [];
  windows.push(...windowsFromRateLimitSnapshot(value.rateLimits, "codex", now));

  const primaryId = value.rateLimits.limitId ?? "codex";
  for (const [limitId, snapshot] of value.rateLimitsByLimitId) {
    if (limitId === primaryId || snapshot.limitId === primaryId || limitId === "codex") {
      continue;
    }
    windows.push(...windowsFromRateLimitSnapshot(snapshot, limitId, now));
  }

  return windows;
}

function windowsFromRateLimitSnapshot(
  snapshot: RateLimitSnapshot,
  fallbackId: string,
  now: Date,
): ProviderLimitWindow[] {
  const label = snapshot.limitName ?? snapshot.limitId ?? fallbackId;
  return [
    ...appServerWindow(`${fallbackId}:primary`, `${label} primary`, snapshot.primary, now),
    ...appServerWindow(`${fallbackId}:secondary`, `${label} secondary`, snapshot.secondary, now),
  ];
}

function appServerWindow(
  id: string,
  label: string,
  window: RateLimitWindow | undefined,
  now: Date,
): ProviderLimitWindow[] {
  if (!window) {
    return [];
  }
  return [
    {
      id,
      label,
      usedPercent: window.usedPercent,
      remainingPercent: clampPercent(100 - window.usedPercent),
      ...(window.resetsAt !== undefined ? resetFields(window.resetsAt, now) : {}),
      ...(window.windowDurationMins !== undefined
        ? { limitDescription: `${window.windowDurationMins}m window` }
        : {}),
    },
  ];
}

function oauthWindows(value: OAuthUsageResponse, now: Date): ProviderLimitWindow[] {
  const windows: ProviderLimitWindow[] = [];
  if (value.rateLimit?.primaryWindow) {
    windows.push(oauthWindow("primary", "Primary", value.rateLimit.primaryWindow, now));
  }
  if (value.rateLimit?.secondaryWindow) {
    windows.push(oauthWindow("secondary", "Secondary", value.rateLimit.secondaryWindow, now));
  }
  for (const limit of value.additionalRateLimits) {
    const id = limit.limitName ?? limit.meteredFeature ?? "additional";
    if (limit.rateLimit?.primaryWindow) {
      windows.push(
        oauthWindow(`${id}:primary`, `${id} primary`, limit.rateLimit.primaryWindow, now),
      );
    }
    if (limit.rateLimit?.secondaryWindow) {
      windows.push(
        oauthWindow(`${id}:secondary`, `${id} secondary`, limit.rateLimit.secondaryWindow, now),
      );
    }
  }
  return windows;
}

function oauthWindow(
  id: string,
  label: string,
  window: OAuthRateLimitWindow,
  now: Date,
): ProviderLimitWindow {
  return {
    id,
    label,
    usedPercent: window.usedPercent,
    remainingPercent: clampPercent(100 - window.usedPercent),
    ...(window.resetAt !== undefined ? resetFields(window.resetAt, now) : {}),
    ...(window.limitWindowSeconds !== undefined
      ? { limitDescription: `${Math.round(window.limitWindowSeconds / 60)}m window` }
      : {}),
  };
}

function creditsFromSnapshots(
  individualLimit: IndividualLimit | undefined,
  credits: CreditDetails | undefined,
  now: Date,
): ProviderCreditsSnapshot | undefined {
  if (individualLimit) {
    const remaining =
      individualLimit.limit !== undefined && individualLimit.used !== undefined
        ? Math.max(0, individualLimit.limit - individualLimit.used)
        : undefined;
    return {
      ...(remaining !== undefined ? { remaining } : {}),
      ...(individualLimit.used !== undefined ? { used: individualLimit.used } : {}),
      ...(individualLimit.limit !== undefined ? { limit: individualLimit.limit } : {}),
      ...(individualLimit.resetsAt !== undefined
        ? { resetsAt: unixSecondsToIso(individualLimit.resetsAt, now) }
        : {}),
      unit: "credits",
    };
  }
  if (!credits) {
    return undefined;
  }
  return {
    ...(credits.balance !== undefined ? { remaining: credits.balance } : {}),
    unit: "credits",
  };
}

function resetCreditsFromAppServer(
  value: { readonly availableCount?: number } | undefined,
): ProviderResetCreditsSnapshot | undefined {
  if (value?.availableCount === undefined) {
    return undefined;
  }
  return { availableCount: Math.max(0, value.availableCount) };
}

function resetCreditsFromOAuth(
  value: unknown,
  now: Date,
): ProviderResetCreditsSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const availableCount = numberValue(value.available_count ?? value.availableCount);
  if (availableCount === undefined) {
    return undefined;
  }
  const nextExpiresAt = nextResetCreditExpiry(value.credits, now);
  return {
    availableCount: Math.max(0, availableCount),
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
  };
}

function optionalResetCreditsFromRecord(value: unknown): {
  rateLimitResetCredits?: { readonly availableCount?: number };
} {
  if (!isRecord(value)) {
    return {};
  }
  const availableCount = numberValue(value.availableCount ?? value.available_count);
  return availableCount === undefined
    ? {}
    : { rateLimitResetCredits: { availableCount: Math.max(0, availableCount) } };
}

function nextResetCreditExpiry(value: unknown, now: Date): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  let earliest: number | undefined;
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const status = stringValue(item.status);
    if (status && status !== "available") {
      continue;
    }
    const expiresAt = isoOrUnixSeconds(item.expires_at ?? item.expiresAt);
    if (expiresAt === undefined || expiresAt <= now.getTime()) {
      continue;
    }
    earliest = earliest === undefined ? expiresAt : Math.min(earliest, expiresAt);
  }

  return earliest === undefined ? undefined : new Date(earliest).toISOString();
}

function resetFields(
  unixSeconds: number,
  now: Date,
): Pick<ProviderLimitWindow, "resetsAt" | "resetDescription"> {
  return {
    resetsAt: unixSecondsToIso(unixSeconds, now),
    resetDescription: resetDescription(unixSeconds, now),
  };
}

function unixSecondsToIso(value: number, now: Date): string {
  const millis = value > 9_999_999_999 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : now.toISOString();
}

function resetDescription(unixSeconds: number, now: Date): string {
  const millis = unixSeconds > 9_999_999_999 ? unixSeconds : unixSeconds * 1000;
  const deltaMs = millis - now.getTime();
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

function isoOrUnixSeconds(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const number = numberValue(value);
  if (number === undefined) {
    return undefined;
  }
  return number > 9_999_999_999 ? number : number * 1000;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function optionalString(key: string, value: unknown): Record<string, string> {
  const parsed = stringValue(value);
  return parsed ? { [key]: parsed } : {};
}

function optionalNumber(key: string, value: unknown): Record<string, number> {
  const parsed = numberValue(value);
  return parsed === undefined ? {} : { [key]: parsed };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
