import type { AgentTaskPsView, TaskDisplayState } from "@backnotprop/orchestrator-core";
import {
  formatDuration,
  formatInline,
  formatTokenUsageCompact,
  formatTokenUsageLabel,
  padNumber,
} from "./terminal-format.ts";

type PsColumnWidths = {
  workspace: number;
  runtime: number;
  work: number;
  status: number;
  model: number;
  cwd: number;
  started: number;
  duration: number;
  tokens: number;
  last: number;
};

export function renderPsView(view: AgentTaskPsView, options: { columns?: number } = {}): string {
  if (view.groups.length === 0) {
    return "No tasks.\n";
  }

  const showWorkspace = view.scope.workspaces === "all";
  const widths = psColumnWidths(options.columns, showWorkspace);
  const lines: string[] = [formatPsSummary(view)];

  for (const group of view.groups) {
    lines.push("");
    lines.push(formatPsGroupHeading(group));
    lines.push(
      `  ${showWorkspace ? `${padCell("workspace", widths.workspace)} ` : ""}${padCell(
        "agent",
        widths.runtime,
      )} ${padCell("work", widths.work)} ${padCell("status", widths.status)} ${padCell(
        "model",
        widths.model,
      )} ${showWorkspace ? `${padCell("cwd", widths.cwd)} ` : ""}${padCell(
        "started",
        widths.started,
      )} ${padCell("dur", widths.duration)} ${padCell("tok", widths.tokens)} ${padCell(
        "last",
        widths.last,
      )} id`,
    );

    for (const row of group.rows) {
      lines.push(
        `  ${showWorkspace ? `${padCell(formatWorkspace(row), widths.workspace)} ` : ""}${padCell(
          row.runtime,
          widths.runtime,
        )} ${padCell(row.name, widths.work)} ${padCell(formatPsRowStatus(row), widths.status)} ${padCell(
          row.model ?? "-",
          widths.model,
        )} ${showWorkspace ? `${padCell(formatCwd(row), widths.cwd)} ` : ""}${padCell(
          formatStartedAt(row, view.generatedAt, widths.started),
          widths.started,
        )} ${padCell(
          formatRowDuration(row),
          widths.duration,
        )} ${padCell(formatTokenUsageCompact(row.usage), widths.tokens)} ${padCell(
          formatPsLast(row),
          widths.last,
        )} ${row.shortTaskId}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function psColumnWidths(columns: number | undefined, showWorkspace: boolean): PsColumnWidths {
  const wide = {
    workspace: 14,
    runtime: 12,
    work: 28,
    status: 8,
    model: 14,
    cwd: 18,
    started: 8,
    duration: 5,
    tokens: 6,
    last: 24,
  };
  if (!columns || columns >= psTableWidth(wide, showWorkspace)) {
    return wide;
  }

  const compact = {
    workspace: 10,
    runtime: 8,
    work: 18,
    status: 7,
    model: 12,
    cwd: 12,
    started: 8,
    duration: 4,
    tokens: 5,
    last: 14,
  };
  if (columns >= psTableWidth(compact, showWorkspace)) {
    return compact;
  }

  return {
    workspace: 8,
    runtime: 6,
    work: 12,
    status: 7,
    model: 7,
    cwd: 8,
    started: 5,
    duration: 3,
    tokens: 4,
    last: 8,
  };
}

function psTableWidth(widths: PsColumnWidths, showWorkspace: boolean): number {
  return (
    2 +
    (showWorkspace ? widths.workspace + widths.cwd : 0) +
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

function formatWorkspace(row: AgentTaskPsView["rows"][number]): string {
  return row.workspaceName ?? basenameFromPath(row.workspaceRoot);
}

function formatCwd(row: AgentTaskPsView["rows"][number]): string {
  return row.relativeCwd ?? row.cwd;
}

function basenameFromPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function formatPsSummary(view: AgentTaskPsView): string {
  const stopping = view.rows.filter((row) => row.state === "stopping").length;
  const stale = view.rows.filter((row) => row.state === "stale").length;
  const orphaned = view.rows.filter((row) => row.state === "orphaned").length;
  const lost = view.rows.filter((row) => row.state === "lost").length;
  const running = view.rows.filter(
    (row) =>
      row.active && row.state !== "stopping" && row.state !== "stale" && row.state !== "orphaned",
  ).length;
  const done = view.rows.filter((row) => row.status === "succeeded").length;
  const stopped = view.rows.filter((row) => row.status === "cancelled").length;
  const failed = view.rows.filter((row) => row.status === "failed").length;
  const timedOut = view.rows.filter((row) => row.status === "timed_out").length;
  const usage = sumPsTokens(view.groups);
  return [
    `updated ${formatGeneratedAt(view.generatedAt)}`,
    `${running} running`,
    stopping > 0 ? `${stopping} stopping` : undefined,
    stale > 0 ? `${stale} stale` : undefined,
    orphaned > 0 ? `${orphaned} orphaned` : undefined,
    lost > 0 ? `${lost} lost` : undefined,
    `${done} done`,
    stopped > 0 ? `${stopped} stopped` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    timedOut > 0 ? `${timedOut} timeout` : undefined,
    usage ? `${formatTokenUsageLabel(usage)} tok` : undefined,
  ]
    .filter(Boolean)
    .join("  ");
}

function formatPsGroupHeading(group: AgentTaskPsView["groups"][number]): string {
  const label = psGroupLabel(group);
  const stopping = group.rows.filter((row) => row.state === "stopping").length;
  const stale = group.rows.filter((row) => row.state === "stale").length;
  const orphaned = group.rows.filter((row) => row.state === "orphaned").length;
  const lost = group.rows.filter((row) => row.state === "lost").length;
  const running = group.rows.filter(
    (row) =>
      row.active && row.state !== "stopping" && row.state !== "stale" && row.state !== "orphaned",
  ).length;
  return [
    label,
    formatPsGroupStatus(group.status),
    `${group.total} ${group.total === 1 ? "agent" : "agents"}`,
    running > 0 ? `${running} running` : undefined,
    stopping > 0 ? `${stopping} stopping` : undefined,
    stale > 0 ? `${stale} stale` : undefined,
    orphaned > 0 ? `${orphaned} orphaned` : undefined,
    lost > 0 ? `${lost} lost` : undefined,
    group.succeeded > 0 ? `${group.succeeded} done` : undefined,
    group.stopped > 0 ? `${group.stopped} stopped` : undefined,
    group.failed > 0 ? `${group.failed} failed` : undefined,
    group.timedOut > 0 ? `${group.timedOut} timeout` : undefined,
    group.usage?.totalTokens !== undefined
      ? `${formatTokenUsageLabel(group.usage)} tok`
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
  return parent?.name ?? group.parentLabel ?? group.label;
}

function formatPsGroupStatus(status: AgentTaskPsView["groups"][number]["status"]): string {
  switch (status) {
    case "succeeded":
      return "done";
    case "timed_out":
      return "timeout";
    default:
      return status;
  }
}

function formatPsStatus(status: TaskDisplayState): string {
  switch (status) {
    case "succeeded":
      return "done";
    case "cancelled":
      return "stopped";
    case "timed_out":
      return "timeout";
    case "stopping":
      return "stopping";
    default:
      return status;
  }
}

function formatPsRowStatus(row: AgentTaskPsView["rows"][number]): string {
  const displayState = row.state ?? row.status;
  if (displayState !== "running") {
    return formatPsStatus(displayState);
  }

  if (row.session) {
    switch (row.session.state) {
      case "idle":
        return "idle";
      case "turn_running":
        return "turn";
      case "goal_running":
        return "goal";
      case "stopping":
        return "stopping";
      case "closed":
        return "closed";
      case "starting":
        return "starting";
    }
  }
  return formatPsStatus(displayState);
}

function formatPsLast(row: AgentTaskPsView["rows"][number]): string {
  const raw = row.error ?? row.lastMessage ?? row.lastEvent;
  if (raw) {
    return summarizePsMessage(raw);
  }
  return formatPsStatus(row.state ?? row.status);
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

function sumPsTokens(
  groups: readonly AgentTaskPsView["groups"][number][],
): AgentTaskPsView["groups"][number]["usage"] | undefined {
  const usage = groups
    .map((group) => group.usage)
    .filter((value) => value?.totalTokens !== undefined);
  if (usage.length === 0) {
    return undefined;
  }

  const totalTokens = usage
    .map((value) => value?.totalTokens)
    .filter((value): value is number => typeof value === "number")
    .reduce((sum, value) => sum + value, 0);
  const final = usage.every((value) => value?.final === true);
  const estimated = usage.some((value) => value?.source === "estimated");
  return {
    totalTokens,
    ...(estimated ? { source: "estimated" } : {}),
    final,
    updatedAt: usage[0]?.updatedAt ?? "",
  };
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
