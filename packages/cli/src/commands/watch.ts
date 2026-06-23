import {
  isTerminalTaskStatus as isTerminalStatus,
  readTaskRecord,
  resolveTaskId,
  type TaskEvent,
} from "@backnotprop/orchestrator-core";
import { isAgentEventLine, parseTaskEventLine } from "../task-events.ts";
import { readNewFileText } from "../task-output.ts";
import { formatInline } from "../terminal-format.ts";

export type WatchOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  taskId: string;
  intervalMs: number;
  agentOnly: boolean;
};

export async function commandWatch(options: WatchOptions): Promise<void> {
  const storeOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.orchestratorDir ? { orchestratorDir: options.orchestratorDir } : {}),
  };
  const taskId = await resolveTaskId(storeOptions, options.taskId);
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let eventsOffset = 0;
  let eventRemainder = "";

  while (true) {
    const task = await readTaskRecord(storeOptions, taskId);

    const eventsRead = await readNewFileText(task.paths.eventsJsonl, eventsOffset);
    eventsOffset = eventsRead.offset;
    if (eventsRead.text) {
      const rendered = renderWatchEvents(
        eventsRead.text,
        eventRemainder,
        options.json,
        options.agentOnly,
      );
      eventRemainder = rendered.remainder;
      if (rendered.output) {
        process.stdout.write(rendered.output);
      }
    }

    if (!options.json && task.launchPlan.outputTransport.kind !== "jsonl_events") {
      const stdoutRead = await readNewFileText(task.paths.stdoutLog, stdoutOffset);
      stdoutOffset = stdoutRead.offset;
      if (stdoutRead.text) {
        process.stdout.write(stdoutRead.text);
      }
    } else {
      stdoutOffset = (await readNewFileText(task.paths.stdoutLog, stdoutOffset)).offset;
    }

    if (options.json) {
      stderrOffset = (await readNewFileText(task.paths.stderrLog, stderrOffset)).offset;
    } else {
      const stderrRead = await readNewFileText(task.paths.stderrLog, stderrOffset);
      stderrOffset = stderrRead.offset;
      if (stderrRead.text) {
        process.stderr.write(stderrRead.text);
      }
    }

    if (isTerminalStatus(task.status)) {
      if (eventRemainder.trim()) {
        const rendered = renderWatchEvents("\n", eventRemainder, options.json, options.agentOnly);
        if (rendered.output) {
          process.stdout.write(rendered.output);
        }
      }
      return;
    }

    await delay(options.intervalMs);
  }
}

function renderWatchEvents(
  text: string,
  remainder: string,
  json: boolean,
  agentOnly: boolean,
): { output: string; remainder: string } {
  const combined = remainder + text;
  const lines = combined.split("\n");
  const nextRemainder = combined.endsWith("\n") ? "" : (lines.pop() ?? "");
  const completeLines = combined.endsWith("\n") ? lines.slice(0, -1) : lines;

  const renderedLines = agentOnly ? completeLines.filter(isAgentEventLine) : completeLines;

  if (json) {
    const output = renderedLines
      .filter((line) => line.trim().length > 0)
      .map((line) => `${line}\n`)
      .join("");
    return { output, remainder: nextRemainder };
  }

  const output = renderedLines
    .map((line) => parseTaskEventLine(line))
    .filter((event): event is TaskEvent => Boolean(event))
    .map(formatWatchEvent)
    .filter((line): line is string => Boolean(line))
    .join("");

  return { output, remainder: nextRemainder };
}

function formatWatchEvent(event: TaskEvent): string | undefined {
  if (event.type === "agent_event") {
    const kind = eventDataString(event, "kind") ?? "agent_event";
    const label =
      eventDataString(event, "itemType") ??
      eventDataString(event, "toolName") ??
      eventDataString(event, "status");
    const message = eventDataString(event, "message");
    return `${[event.ts, kind, label, message ? formatInline(message) : undefined]
      .filter(Boolean)
      .join("\t")}\n`;
  }

  if (
    event.type === "queued" ||
    event.type === "starting" ||
    event.type === "running" ||
    event.type === "result" ||
    event.type === "completed" ||
    event.type === "failed" ||
    event.type === "cancelled" ||
    event.type === "timed_out" ||
    event.type === "interrupt_requested"
  ) {
    const pid = eventDataString(event, "pid");
    return `${[event.ts, event.type, pid ? `pid=${pid}` : undefined].filter(Boolean).join("\t")}\n`;
  }

  return undefined;
}

function eventDataString(event: TaskEvent, key: string): string | undefined {
  const value = event.data[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
