import type { AgentLaunchPlan } from "../runtime/index.ts";

export const TASK_STATUSES = [
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

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
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  source?: "provider" | "runtime" | "estimated";
  scope?: "turn" | "task" | "session" | "account";
  final?: boolean;
  updatedAt: string;
};

export type TaskOutputCapture = {
  maxBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  resultTruncated: boolean;
  updatedAt: string;
};

export type TaskStoreScope = "machine" | "custom";

export type LocalTaskLocation = {
  kind: "local";
  workspaceRoot: string;
  workspaceName?: string;
  cwd: string;
};

export type RemoteTaskLocation = {
  kind: "remote";
  workspaceRoot?: string;
  workspaceName?: string;
  cwd?: string;
  remote?: string;
  remoteTaskId?: string;
};

export type TaskLocation = LocalTaskLocation | RemoteTaskLocation;

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
  storeScope?: TaskStoreScope;
  location?: TaskLocation;
  labels?: Record<string, string>;
  usage?: TaskUsage;
  outputCapture?: TaskOutputCapture;
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
  location?: TaskLocation;
  labels?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
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

export type InterruptTasksTarget =
  | {
      kind: "task";
      taskId: string;
      children?: boolean;
      taskOnly?: boolean;
    }
  | {
      kind: "tasks";
      taskIds: readonly string[];
    }
  | {
      kind: "parent";
      parentId: string;
      children: true;
    }
  | {
      kind: "group";
      groupId: string;
    }
  | {
      kind: "active";
    };

export type InterruptTasksInput = TaskStoreOptions & {
  target: InterruptTasksTarget;
  allWorkspaces?: boolean;
  cwd?: string;
  reason?: string;
  signal?: NodeJS.Signals;
};

export type InterruptTasksSkipped = {
  task: AgentTaskRecord;
  reason: "terminal";
};

export type InterruptTasksFailed = {
  taskId: string;
  error: string;
};

export type InterruptTasksResult = {
  target: InterruptTasksTarget;
  interrupted: AgentTaskRecord[];
  skipped: InterruptTasksSkipped[];
  failed: InterruptTasksFailed[];
};
