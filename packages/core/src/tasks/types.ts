import type { AgentLaunchPlan } from "../runtime/index.ts";

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

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

export type AgentTaskRecord = {
  taskId: string;
  name?: string;
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

export type InterruptTaskInput = TaskStoreOptions & {
  taskId: string;
  reason?: string;
  signal?: NodeJS.Signals;
};
