export function formatInline(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

export function formatTokenUsage(tokens: number | undefined): string {
  if (tokens === undefined) {
    return "-";
  }
  if (tokens < 1_000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export type TokenUsageDisplay = {
  totalTokens?: number;
  source?: string;
  final?: boolean;
};

export function formatTokenUsageCompact(usage: TokenUsageDisplay | undefined): string {
  if (!usage) {
    return "-";
  }

  const value = formatTokenUsage(usage.totalTokens);
  if (value === "-") {
    return value;
  }
  if (usage.source === "estimated") {
    return `~${value}`;
  }
  return value;
}

export function formatTokenUsageLabel(usage: TokenUsageDisplay | undefined): string {
  if (!usage) {
    return "-";
  }

  const value = formatTokenUsage(usage.totalTokens);
  if (value === "-") {
    return value;
  }
  if (usage.source === "estimated") {
    return `${value} est`;
  }
  return value;
}

export function padNumber(value: number): string {
  return String(value).padStart(2, "0");
}
