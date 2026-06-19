import { readFile, stat } from "node:fs/promises";
import { readTaskRecord } from "./store.ts";
import type {
  ReadTaskEventsInput,
  ReadTaskLogsInput,
  ReadTaskLogsResult,
  TaskEvent,
} from "./types.ts";

const DEFAULT_LOG_MAX_BYTES = 200_000;
const DEFAULT_EVENTS_MAX_BYTES = 500_000;

export async function readTaskLogs(input: ReadTaskLogsInput): Promise<ReadTaskLogsResult> {
  const task = await readTaskRecord(input, input.taskId);
  const maxBytes = input.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const stream = input.stream ?? "all";

  return {
    taskId: task.taskId,
    stdout: stream === "stderr" ? "" : await readTailIfExists(task.paths.stdoutLog, maxBytes),
    stderr: stream === "stdout" ? "" : await readTailIfExists(task.paths.stderrLog, maxBytes),
  };
}

export async function readTaskEvents(input: ReadTaskEventsInput): Promise<TaskEvent[]> {
  const task = await readTaskRecord(input, input.taskId);
  const raw = await readTailIfExists(
    task.paths.eventsJsonl,
    input.maxBytes ?? DEFAULT_EVENTS_MAX_BYTES,
  );
  const lines = raw.trim() ? raw.trimEnd().split("\n") : [];
  const events = lines.flatMap((line) => {
    const event = parseTaskEventLine(line);
    return event ? [event] : [];
  });

  return input.agentOnly ? events.filter((event) => event.type === "agent_event") : events;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  const contents = await readFile(path);

  if (fileStat.size <= maxBytes) {
    return contents.toString("utf8");
  }

  return contents.subarray(contents.byteLength - maxBytes).toString("utf8");
}

async function readTailIfExists(path: string, maxBytes: number): Promise<string> {
  try {
    return await readTail(path, maxBytes);
  } catch (error) {
    if (isMissingFile(error)) {
      return "";
    }
    throw error;
  }
}

function parseTaskEventLine(line: string): TaskEvent | undefined {
  try {
    return JSON.parse(line) as TaskEvent;
  } catch {
    return undefined;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
