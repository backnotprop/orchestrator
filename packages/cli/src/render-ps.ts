import { isTerminalTaskStatus } from "@backnotprop/orchestrator-core";
import type { AgentTaskPsView, TaskStatus } from "@backnotprop/orchestrator-core";
import { formatDuration, formatInline, formatTokenUsage, padNumber } from "./terminal-format.ts";

type PsColumnWidths = {
  runtime: number;
  work: number;
  status: number;
  model: number;
  started: number;
  duration: number;
  tokens: number;
  last: number;
};

export function renderPsView(view: AgentTaskPsView, options: { columns?: number } = {}): string {
  if (view.groups.length === 0) {
    return "No tasks.\n";
  }

  const widths = psColumnWidths(options.columns);
  const lines: string[] = [formatPsSummary(view)];

  for (const group of view.groups) {
    lines.push("");
    lines.push(formatPsGroupHeading(group));
    lines.push(
      `  ${padCell("agent", widths.runtime)} ${padCell("work", widths.work)} ${padCell(
        "status",
        widths.status,
      )} ${padCell("model", widths.model)} ${padCell(
        "started",
        widths.started,
      )} ${padCell("dur", widths.duration)} ${padCell("tok", widths.tokens)} ${padCell(
        "last",
        widths.last,
      )} id`,
    );

    for (const row of group.rows) {
      lines.push(
        `  ${padCell(row.runtime, widths.runtime)} ${padCell(row.name, widths.work)} ${padCell(
          formatPsStatus(row.status),
          widths.status,
        )} ${padCell(
          row.model ?? "-",
          widths.model,
        )} ${padCell(formatStartedAt(row, view.generatedAt, widths.started), widths.started)} ${padCell(
          formatRowDuration(row),
          widths.duration,
        )} ${padCell(formatTokenUsage(row.usage?.totalTokens), widths.tokens)} ${padCell(
          formatPsLast(row),
          widths.last,
        )} ${row.shortTaskId}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function psColumnWidths(columns: number | undefined): PsColumnWidths {
  const wide = {
    runtime: 12,
    work: 28,
    status: 8,
    model: 14,
    started: 8,
    duration: 5,
    tokens: 6,
    last: 24,
  };
  if (!columns || columns >= psTableWidth(wide)) {
    return wide;
  }

  const compact = {
    runtime: 8,
    work: 18,
    status: 7,
    model: 12,
    started: 8,
    duration: 4,
    tokens: 5,
    last: 14,
  };
  if (columns >= psTableWidth(compact)) {
    return compact;
  }

  return {
    runtime: 6,
    work: 12,
    status: 7,
    model: 7,
    started: 5,
    duration: 3,
    tokens: 4,
    last: 8,
  };
}

function psTableWidth(widths: PsColumnWidths): number {
  return (
    2 +
    widths.runtime +
    widths.work +
    widths.status +
    widths.model +
    widths.started +
    widths.duration +
    widths.tokens +
    widths.last +
    8 +
    8
  );
}

function formatPsSummary(view: AgentTaskPsView): string {
  const running = view.rows.filter((row) => !isTerminalTaskStatus(row.status)).length;
  const done = view.rows.filter((row) => row.status === "succeeded").length;
  const failed = view.rows.filter((row) => isFailedPsStatus(row.status)).length;
  const usage = sumPsTokens(view.groups);
  return [
    `updated ${formatGeneratedAt(view.generatedAt)}`,
    `${running} running`,
    `${done} done`,
    failed > 0 ? `${failed} failed` : undefined,
    usage !== undefined ? `${formatTokenUsage(usage)} tok` : undefined,
  ]
    .filter(Boolean)
    .join("  ");
}

function formatPsGroupHeading(group: AgentTaskPsView["groups"][number]): string {
  const label = psGroupLabel(group);
  return [
    label,
    formatPsGroupStatus(group.status),
    `${group.total} ${group.total === 1 ? "agent" : "agents"}`,
    group.running > 0 ? `${group.running} running` : undefined,
    group.succeeded > 0 ? `${group.succeeded} done` : undefined,
    group.failed > 0 ? `${group.failed} failed` : undefined,
    group.usage?.totalTokens !== undefined
      ? `${formatTokenUsage(group.usage.totalTokens)} tok`
      : undefined,
  ]
    .filter(Boolean)
    .join("  ");
}

function psGroupLabel(group: AgentTaskPsView["groups"][number]): string {
  if (group.groupId === "ungrouped") {
    return "manual launches";
  }

  const parent = group.rows.find((row) => row.taskId === group.parentTaskId);
  return parent?.name ?? group.label;
}

function formatPsGroupStatus(status: AgentTaskPsView["groups"][number]["status"]): string {
  return status === "succeeded" ? "done" : status;
}

function formatPsStatus(status: TaskStatus): string {
  switch (status) {
    case "succeeded":
      return "done";
    case "cancelled":
      return "stopped";
    case "timed_out":
      return "timeout";
    default:
      return status;
  }
}

function formatPsLast(row: AgentTaskPsView["rows"][number]): string {
  const raw = row.error ?? row.lastMessage ?? row.lastEvent;
  if (raw) {
    return summarizePsMessage(raw);
  }
  return formatPsStatus(row.status);
}

function summarizePsMessage(value: string): string {
  const inline = formatInline(value);
  const parsed = extractJsonMessage(inline);
  if (parsed) {
    return parsed;
  }

  if (inline.startsWith("runtime.")) {
    return inline.slice("runtime.".length).replaceAll("_", " ");
  }

  if (inline.startsWith("agent.")) {
    return inline.slice("agent.".length).replaceAll("_", " ");
  }

  const statusMessage = psEventStatusMessage(inline);
  if (statusMessage) {
    return statusMessage;
  }

  return inline;
}

function psEventStatusMessage(value: string): string | undefined {
  switch (value) {
    case "completed":
    case "succeeded":
      return "done";
    case "cancelled":
      return "stopped";
    case "timed_out":
      return "timeout";
    default:
      return undefined;
  }
}

function extractJsonMessage(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return messageFromUnknown(JSON.parse(trimmed) as unknown);
  } catch {
    return undefined;
  }
}

function messageFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return typeof value === "string" ? value : undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "reason", "status"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      return extractJsonMessage(candidate) ?? candidate;
    }
    const nested = messageFromUnknown(candidate);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function isFailedPsStatus(status: TaskStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "timed_out";
}

function sumPsTokens(groups: readonly AgentTaskPsView["groups"][number][]): number | undefined {
  const known = groups
    .map((group) => group.usage?.totalTokens)
    .filter((value): value is number => typeof value === "number");
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : undefined;
}

function padCell(value: string, width: number): string {
  const inline = formatInline(value);
  const truncated =
    inline.length > width ? `${inline.slice(0, Math.max(0, width - 3))}...` : inline;
  return truncated.padEnd(width);
}

function formatRowDuration(row: AgentTaskPsView["rows"][number]): string {
  if (row.durationMs !== undefined) {
    return formatDuration(row.durationMs);
  }
  return formatDuration(row.ageMs);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatStartedAt(
  row: AgentTaskPsView["rows"][number],
  generatedAt: string,
  width: number,
): string {
  const timestamp = row.startedAt ?? row.createdAt;
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) {
    return "-";
  }

  const generated = new Date(generatedAt);
  if (isSameLocalDate(value, generated)) {
    const hoursAndMinutes = `${padNumber(value.getHours())}:${padNumber(value.getMinutes())}`;
    return width <= 5 ? hoursAndMinutes : `${hoursAndMinutes}:${padNumber(value.getSeconds())}`;
  }

  if (width <= 5) {
    return `${value.getMonth() + 1}/${value.getDate()}`;
  }

  return `${MONTHS[value.getMonth()]} ${value.getDate()} ${padNumber(value.getHours())}:${padNumber(
    value.getMinutes(),
  )}`;
}

function formatGeneratedAt(generatedAt: string): string {
  const value = new Date(generatedAt);
  if (!Number.isFinite(value.getTime())) {
    return generatedAt;
  }
  return `${padNumber(value.getHours())}:${padNumber(value.getMinutes())}:${padNumber(
    value.getSeconds(),
  )}`;
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
