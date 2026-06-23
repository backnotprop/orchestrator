import type { TaskEvent } from "@backnotprop/orchestrator-core";

export function parseTaskEventLine(line: string): TaskEvent | undefined {
  if (!line.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(line) as TaskEvent;
  } catch {
    return undefined;
  }
}

export function isAgentEventLine(line: string): boolean {
  return parseTaskEventLine(line)?.type === "agent_event";
}
