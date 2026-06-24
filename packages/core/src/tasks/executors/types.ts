import type { AgentTaskRecord, LaunchTaskInput, TaskEvent, TaskPaths } from "../types.ts";

export type TaskExecutionContext = {
  input: LaunchTaskInput;
  taskId: string;
  task: AgentTaskRecord;
  paths: TaskPaths;
  maxOutputBytes: number;
  appendEvent: (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<TaskEvent>;
};

export type TaskExecutionHandle = {
  completed: Promise<AgentTaskRecord>;
  interrupt(reason: string, signal?: NodeJS.Signals): Promise<void> | void;
};

export type TaskExecutor = {
  start(context: TaskExecutionContext): TaskExecutionHandle;
};
