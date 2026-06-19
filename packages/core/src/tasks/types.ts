import type { AgentLaunchPlan } from "../runtime/index.ts";

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}

export type TaskPaths = {
  taskDir: string;
  taskJson: string;
  stdoutLog: string;
  stderrLog: string;
  eventsJsonl: string;
  transcriptJsonl: string;
  resultMd: string;
  artifactsDir: string;
};

export type TaskParent = {
  parentRunId: string;
  parentTaskId?: string;
  parentSessionId?: string;
  parentToolCallId?: string;
};

export type TaskUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  updatedAt: string;
};

export type AgentTaskRecord = {
  taskId: string;
  name?: string;
  model?: string;
  runtime: string;
  launchPlan: AgentLaunchPlan;
  cwd: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  pid?: number;
  error?: string;
  parent?: TaskParent;
  usage?: TaskUsage;
  paths: TaskPaths;
};

export type TaskEvent = {
  seq: number;
  taskId: string;
  ts: string;
  type:
    | "queued"
    | "starting"
    | "running"
    | "stdout"
    | "stderr"
    | "agent_event"
    | "interrupt_requested"
    | "result"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out";
  data: Record<string, unknown>;
};

export type TaskStoreOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
};

export type LaunchTaskInput = TaskStoreOptions & {
  plan: AgentLaunchPlan;
  taskId?: string;
  name?: string;
  model?: string;
  parent?: TaskParent;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedShellCommands?: readonly string[];
};

export type LaunchTaskHandle = {
  task: AgentTaskRecord;
  completed: Promise<AgentTaskRecord>;
};

export type ListTasksInput = TaskStoreOptions & {
  status?: TaskStatus;
};

export type ReadTaskOutputInput = TaskStoreOptions & {
  taskId: string;
  maxBytes?: number;
};

export type WaitForTaskInput = TaskStoreOptions & {
  taskId: string;
  timeoutMs?: number;
  intervalMs?: number;
  progressIntervalMs?: number;
  onProgress?: (progress: WaitForTaskProgress) => void;
};

export type WaitForTaskProgress = {
  task: AgentTaskRecord;
  elapsedMs: number;
  timeoutMs: number;
  remainingMs: number;
  attempt: number;
};

export type WaitForTaskResult = {
  retrievalStatus: "completed" | "timeout";
  task: AgentTaskRecord;
};

export type LogStream = "stdout" | "stderr" | "all";

export type ReadTaskLogsInput = TaskStoreOptions & {
  taskId: string;
  stream?: LogStream;
  maxBytes?: number;
};

export type ReadTaskLogsResult = {
  taskId: string;
  stdout: string;
  stderr: string;
};

export type ReadTaskEventsInput = TaskStoreOptions & {
  taskId: string;
  maxBytes?: number;
  agentOnly?: boolean;
};

export type InterruptTaskInput = TaskStoreOptions & {
  taskId: string;
  reason?: string;
  signal?: NodeJS.Signals;
};
