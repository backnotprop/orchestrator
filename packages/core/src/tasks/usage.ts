import type { TaskUsage } from "./types.ts";

export type NormalizedTaskUsage = Omit<TaskUsage, "updatedAt"> & {
  updatedAt?: string;
};

export type NormalizeTaskUsageOptions = {
  updatedAt?: string;
  defaults?: Partial<Pick<TaskUsage, "source" | "scope" | "final">>;
};

export function normalizeTaskUsage(
  value: unknown,
  options: NormalizeTaskUsageOptions = {},
): NormalizedTaskUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = numberFromKeys(value, ["inputTokens", "input_tokens"]);
  const outputTokens = numberFromKeys(value, ["outputTokens", "output_tokens"]);
  const cacheReadTokens = numberFromKeys(value, [
    "cacheReadTokens",
    "cache_read_tokens",
    "cacheRead",
    "cache_read",
  ]);
  const cacheWriteTokens = numberFromKeys(value, [
    "cacheWriteTokens",
    "cache_write_tokens",
    "cacheWrite",
    "cache_write",
  ]);
  const reasoningTokens = numberFromKeys(value, ["reasoningTokens", "reasoning_tokens"]);
  const totalTokens =
    numberFromKeys(value, ["totalTokens", "total_tokens"]) ??
    inferTotalTokens({
      inputTokens,
      outputTokens,
    });
  const costUsd = numberFromKeys(value, ["costUsd", "cost_usd"]);
  const source = usageSourceFromUnknown(value.source) ?? options.defaults?.source;
  const scope = usageScopeFromUnknown(value.scope) ?? options.defaults?.scope;
  const final = booleanFromUnknown(value.final) ?? options.defaults?.final;

  const usage = compactData({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    costUsd,
    source,
    scope,
    final,
    updatedAt: options.updatedAt,
  }) as NormalizedTaskUsage;

  return hasUsageMetric(usage) ? usage : undefined;
}

export function usageWithUpdatedAt(usage: NormalizedTaskUsage, updatedAt: string): TaskUsage {
  return {
    ...usage,
    updatedAt: usage.updatedAt ?? updatedAt,
  };
}

export function selectTaskUsage(
  current: TaskUsage | undefined,
  candidate: TaskUsage | undefined,
): TaskUsage | undefined {
  const validCurrent = current && isTaskSummaryCandidate(current) ? current : undefined;
  if (!candidate) {
    return validCurrent;
  }
  if (!isTaskSummaryCandidate(candidate)) {
    return validCurrent;
  }
  if (!validCurrent) {
    return candidate;
  }

  const currentScore = usageScore(validCurrent);
  const candidateScore = usageScore(candidate);
  if (candidateScore > currentScore) {
    return candidate;
  }
  if (candidateScore < currentScore) {
    return validCurrent;
  }
  return candidate.updatedAt >= validCurrent.updatedAt ? candidate : validCurrent;
}

export function sumTaskUsage(values: readonly TaskUsage[]): TaskUsage | undefined {
  const candidates = aggregateCandidates(values);
  if (candidates.length === 0) {
    return undefined;
  }

  const updatedAt = candidates.reduce(
    (latest, usage) => (usage.updatedAt > latest ? usage.updatedAt : latest),
    candidates[0]?.updatedAt ?? new Date(0).toISOString(),
  );
  const finalValues = candidates.map((usage) => usage.final);
  const sourceValues = new Set(candidates.map((usage) => usage.source).filter(Boolean));

  return compactData({
    inputTokens: sumNumbers(candidates.map((usage) => usage.inputTokens)),
    outputTokens: sumNumbers(candidates.map((usage) => usage.outputTokens)),
    cacheReadTokens: sumNumbers(candidates.map((usage) => usage.cacheReadTokens)),
    cacheWriteTokens: sumNumbers(candidates.map((usage) => usage.cacheWriteTokens)),
    reasoningTokens: sumNumbers(candidates.map((usage) => usage.reasoningTokens)),
    totalTokens: sumNumbers(candidates.map((usage) => usage.totalTokens)),
    costUsd: sumNumbers(candidates.map((usage) => usage.costUsd)),
    source: aggregateSource(sourceValues),
    scope: "task",
    final: finalValues.length > 0 && finalValues.every((value) => value === true),
    updatedAt,
  }) as TaskUsage;
}

function isTaskSummaryCandidate(usage: TaskUsage): boolean {
  return usage.scope !== "account" && usage.source !== "estimated";
}

function aggregateSource(values: ReadonlySet<TaskUsage["source"]>): TaskUsage["source"] {
  if (values.size === 0) {
    return undefined;
  }
  if (values.size === 1) {
    return [...values][0];
  }
  return "runtime";
}

function aggregateCandidates(values: readonly TaskUsage[]): TaskUsage[] {
  const nonEstimated = values.filter((usage) => usage.source !== "estimated");
  const taskOrTurn = nonEstimated.filter(
    (usage) => usage.scope === undefined || usage.scope === "task" || usage.scope === "turn",
  );
  if (taskOrTurn.length > 0) {
    return taskOrTurn;
  }
  return nonEstimated.filter((usage) => usage.scope === "session");
}

function usageScore(usage: TaskUsage): number {
  return (
    scopeScore(usage.scope) +
    sourceScore(usage.source) +
    finalScore(usage.final) +
    metricScore(usage)
  );
}

function scopeScore(scope: TaskUsage["scope"]): number {
  switch (scope) {
    case "task":
      return 300;
    case "turn":
      return 250;
    case "session":
      return 100;
    case "account":
      return 0;
    default:
      return 240;
  }
}

function sourceScore(source: TaskUsage["source"]): number {
  switch (source) {
    case "provider":
      return 30;
    case "runtime":
      return 25;
    case "estimated":
      return 0;
    default:
      return 15;
  }
}

function finalScore(final: boolean | undefined): number {
  if (final === true) {
    return 50;
  }
  if (final === false) {
    return 0;
  }
  return 5;
}

function metricScore(usage: NormalizedTaskUsage): number {
  return usage.totalTokens !== undefined ? 5 : 1;
}

function inferTotalTokens(values: {
  inputTokens?: number;
  outputTokens?: number;
}): number | undefined {
  return values.inputTokens !== undefined && values.outputTokens !== undefined
    ? values.inputTokens + values.outputTokens
    : undefined;
}

function hasUsageMetric(usage: NormalizedTaskUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.costUsd !== undefined
  );
}

function numberFromKeys(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = numberFromUnknown(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function sumNumbers(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : undefined;
}

function usageSourceFromUnknown(value: unknown): TaskUsage["source"] | undefined {
  return value === "provider" || value === "runtime" || value === "estimated" ? value : undefined;
}

function usageScopeFromUnknown(value: unknown): TaskUsage["scope"] | undefined {
  return value === "turn" || value === "task" || value === "session" || value === "account"
    ? value
    : undefined;
}

function booleanFromUnknown(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}
