import type {
  AgentTaskRecord,
  LaunchTaskInput,
  TaskEvent,
  TaskPaths,
  TaskProviderMetadata,
  TaskSendMessageFailureReason,
  TaskStatus,
  TaskUsage,
} from "../types.ts";

export type TaskExecutionContext = {
  input: LaunchTaskInput;
  taskId: string;
  task: AgentTaskRecord;
  paths: TaskPaths;
  maxOutputBytes: number;
  appendEvent: (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<TaskEvent>;
  appendStdout: (chunk: Buffer | string) => Promise<void>;
  appendStderr: (chunk: Buffer | string) => Promise<void>;
  appendCombined: (chunk: Buffer | string) => Promise<void>;
  appendTranscript: (line: string | Record<string, unknown>) => Promise<void>;
  updateTask: (patch: Partial<AgentTaskRecord>) => Promise<AgentTaskRecord>;
  setStatus: (status: TaskStatus, details?: Partial<AgentTaskRecord>) => Promise<AgentTaskRecord>;
  updateUsage: (usage: TaskUsage) => Promise<void>;
  updateProvider: (provider: TaskProviderMetadata) => Promise<void>;
  writeResult: (text: string) => Promise<void>;
  markTerminal: (
    status: TaskStatus,
    details?: Partial<AgentTaskRecord>,
    eventData?: Record<string, unknown>,
  ) => Promise<AgentTaskRecord>;
};

export type TaskExecutionHandle = {
  completed: Promise<AgentTaskRecord>;
  interrupt(reason: string, signal?: NodeJS.Signals): Promise<void> | void;
  sendMessage?(input: TaskSendMessageInput): Promise<TaskSendMessageResult>;
};

export type TaskExecutor = {
  start(context: TaskExecutionContext): TaskExecutionHandle;
};

export type TaskSendMessageInput = {
  text: string;
  clientMessageId?: string;
  timeoutMs?: number;
};

export type TaskSendMessageResult = {
  status: "accepted";
  provider?: TaskProviderMetadata;
};

export class TaskSendMessageError extends Error {
  readonly reason: TaskSendMessageFailureReason;

  constructor(reason: TaskSendMessageFailureReason, message: string) {
    super(message);
    this.name = "TaskSendMessageError";
    this.reason = reason;
  }
}
