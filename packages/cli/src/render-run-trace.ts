import type { RunStreamEvent } from "@backnotprop/orchestrator-agent";
import { formatDuration, formatInline, formatTokenUsageLabel } from "./terminal-format.ts";

export function renderRunTraceEvents(events: readonly RunStreamEvent[]): string {
  const taskEventToolCallIds = new Set(events.flatMap((event) => taskToolCallId(event) ?? []));
  const progressToolCallIds = new Set(
    events.filter((event) => event.kind === "tool.progress").map((event) => event.toolCallId),
  );
  let output = "";

  for (const event of events) {
    const rendered = renderRunTraceEvent(event, {
      taskEventToolCallIds,
      progressToolCallIds,
    });
    if (rendered) {
      output += rendered;
    }
  }

  return output;
}

function renderRunTraceEvent(
  event: RunStreamEvent,
  options: { taskEventToolCallIds: ReadonlySet<string>; progressToolCallIds: ReadonlySet<string> },
): string {
  switch (event.kind) {
    case "tool.call":
      return renderToolCall(event);
    case "tool.progress":
      return renderToolProgress(event);
    case "tool.result":
      return options.taskEventToolCallIds.has(event.toolCallId) ? "" : renderToolResult(event);
    case "tool.error":
      return `${toolPastTense(event.toolName)} failed: ${event.error.message}\n`;
    case "task.started":
      return `  task ${shortId(event.taskId)} started\n`;
    case "task.status":
      if (event.toolCallId && options.progressToolCallIds.has(event.toolCallId)) {
        return "";
      }
      return `  still ${event.status}: ${taskLabel(event)}\n`;
    case "task.usage":
      return `  tokens ${formatTokenUsageLabel(event.usage)}: ${taskLabel(event)}\n`;
    case "task.finished":
      return renderTaskFinished(event);
    case "run.started":
    case "run.final":
    case "run.error":
      return "";
  }
}

function renderToolCall(event: Extract<RunStreamEvent, { kind: "tool.call" }>): string {
  const input = recordFromUnknown(event.input);

  switch (event.toolName) {
    case "launch_agent": {
      const runtime = stringFromUnknown(input?.runtime) ?? "agent";
      const name =
        stringFromUnknown(input?.name) ??
        summarizeText(stringFromUnknown(input?.instructions)) ??
        "task";
      const model = stringFromUnknown(input?.model);
      return `launching ${runtime}${model ? ` (${model})` : ""}: ${formatInline(name)}\n`;
    }
    case "read_agent": {
      const taskId = stringFromUnknown(input?.taskId) ?? "agent";
      const wait = input?.wait === true;
      return `${wait ? "waiting for" : "reading"} ${shortId(taskId)}\n`;
    }
    case "list_agents":
      return "listing agents\n";
    case "read_agent_events": {
      const taskId = stringFromUnknown(input?.taskId) ?? "agent";
      return `reading events for ${shortId(taskId)}\n`;
    }
    case "read_agent_logs": {
      const taskId = stringFromUnknown(input?.taskId) ?? "agent";
      return `reading logs for ${shortId(taskId)}\n`;
    }
    case "interrupt_agent": {
      const taskId = stringFromUnknown(input?.taskId) ?? "agent";
      return `interrupting ${shortId(taskId)}\n`;
    }
    default:
      return `calling ${event.toolName}\n`;
  }
}

function renderToolProgress(event: Extract<RunStreamEvent, { kind: "tool.progress" }>): string {
  if (event.toolName !== "read_agent") {
    return `  still working ${formatDuration(event.elapsedMs)}\n`;
  }

  const progress = recordFromUnknown(event.progress);
  const status = stringFromUnknown(progress?.status) ?? "running";
  const label =
    stringFromUnknown(progress?.name) ??
    stringFromUnknown(progress?.runtime) ??
    stringFromUnknown(progress?.taskId) ??
    "agent";
  return `  still ${status} ${formatDuration(event.elapsedMs)}: ${formatInline(label)}\n`;
}

function renderToolResult(event: Extract<RunStreamEvent, { kind: "tool.result" }>): string {
  const result = recordFromUnknown(event.result);

  switch (event.toolName) {
    case "list_agents": {
      const tasks = Array.isArray(result?.tasks) ? result.tasks.length : undefined;
      return `listed ${tasks ?? 0} agents\n`;
    }
    case "read_agent_events": {
      const events = Array.isArray(result?.events) ? result.events.length : undefined;
      return `read ${events ?? 0} events\n`;
    }
    case "read_agent_logs": {
      const stdoutBytes = textBytes(result?.stdout);
      const stderrBytes = textBytes(result?.stderr);
      return `read logs: stdout ${stdoutBytes} bytes, stderr ${stderrBytes} bytes\n`;
    }
    case "interrupt_agent":
      return "interrupted agent\n";
    default:
      return `${toolPastTense(event.toolName)} done\n`;
  }
}

function renderTaskFinished(event: Extract<RunStreamEvent, { kind: "task.finished" }>): string {
  if (event.status === "succeeded") {
    const output = summarizeText(event.output);
    return output ? `  done: ${output}\n` : "  done\n";
  }

  const message = event.error?.message ?? summarizeText(event.output);
  return message ? `  ${event.status}: ${message}\n` : `  ${event.status}\n`;
}

function taskToolCallId(event: RunStreamEvent): string | undefined {
  switch (event.kind) {
    case "task.started":
    case "task.status":
    case "task.finished":
      return event.toolCallId;
    default:
      return undefined;
  }
}

function taskLabel(event: { taskId: string; name?: string; runtime: string }): string {
  return formatInline(event.name ?? event.runtime ?? shortId(event.taskId));
}

function toolPastTense(toolName: string): string {
  switch (toolName) {
    case "launch_agent":
      return "launch";
    case "read_agent":
      return "read";
    case "list_agents":
      return "list";
    case "read_agent_events":
      return "read events";
    case "read_agent_logs":
      return "read logs";
    case "interrupt_agent":
      return "interrupt";
    default:
      return toolName;
  }
}

function summarizeText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const text = formatInline(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textBytes(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value) : 0;
}
