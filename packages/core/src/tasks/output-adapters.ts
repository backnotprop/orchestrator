import { appendFile } from "node:fs/promises";
import type { AgentLaunchPlan } from "../runtime/index.ts";
import type { TaskEvent, TaskPaths } from "./types.ts";

export type RuntimeOutputAdapterResult = {
  resultText?: string;
  errorText?: string;
};

export type RuntimeOutputAdapter = {
  onStdoutChunk(chunk: Buffer): Promise<void>;
  onStderrChunk(chunk: Buffer): Promise<void>;
  finalize(): Promise<RuntimeOutputAdapterResult>;
};

type AppendEvent = (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<void>;

export function createRuntimeOutputAdapter(input: {
  plan: AgentLaunchPlan;
  paths: TaskPaths;
  appendEvent: AppendEvent;
}): RuntimeOutputAdapter {
  switch (input.plan.outputTransport.kind) {
    case "jsonl_events":
      return new JsonlRuntimeOutputAdapter(input.plan, input.paths, input.appendEvent);
    case "stdout_json":
      return new StdoutJsonOutputAdapter();
    case "stdout_text":
    case "transcript_file":
      return new NoopOutputAdapter();
  }
}

class NoopOutputAdapter implements RuntimeOutputAdapter {
  async onStdoutChunk(): Promise<void> {}
  async onStderrChunk(): Promise<void> {}
  async finalize(): Promise<RuntimeOutputAdapterResult> {
    return {};
  }
}

class StdoutJsonOutputAdapter implements RuntimeOutputAdapter {
  private stdout = "";

  async onStdoutChunk(chunk: Buffer): Promise<void> {
    this.stdout += chunk.toString("utf8");
  }

  async onStderrChunk(): Promise<void> {}

  async finalize(): Promise<RuntimeOutputAdapterResult> {
    const trimmed = this.stdout.trim();
    if (!trimmed) {
      return {};
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const resultText = extractGenericResultText(parsed);
      return resultText !== undefined ? { resultText } : {};
    } catch {
      return {};
    }
  }
}

class JsonlRuntimeOutputAdapter implements RuntimeOutputAdapter {
  private stdoutRemainder = "";
  private resultText: string | undefined;
  private errorText: string | undefined;
  private readonly plan: AgentLaunchPlan;
  private readonly paths: TaskPaths;
  private readonly appendEvent: AppendEvent;

  constructor(plan: AgentLaunchPlan, paths: TaskPaths, appendEvent: AppendEvent) {
    this.plan = plan;
    this.paths = paths;
    this.appendEvent = appendEvent;
  }

  async onStdoutChunk(chunk: Buffer): Promise<void> {
    this.stdoutRemainder += chunk.toString("utf8");

    while (true) {
      const newlineIndex = this.stdoutRemainder.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.stdoutRemainder.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutRemainder = this.stdoutRemainder.slice(newlineIndex + 1);
      await this.consumeJsonlLine(line);
    }
  }

  async onStderrChunk(): Promise<void> {}

  async finalize(): Promise<RuntimeOutputAdapterResult> {
    const lastLine = this.stdoutRemainder.trim();
    if (lastLine) {
      await this.consumeJsonlLine(lastLine);
    }
    this.stdoutRemainder = "";

    return {
      ...(this.resultText !== undefined ? { resultText: this.resultText } : {}),
      ...(this.errorText !== undefined ? { errorText: this.errorText } : {}),
    };
  }

  private async consumeJsonlLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    await appendFile(this.paths.transcriptJsonl, `${line}\n`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      await this.appendEvent(
        "agent_event",
        compactData({
          runtime: this.plan.runtime,
          source: "stdout",
          kind: "runtime.parse_error",
          message: error instanceof Error ? error.message : String(error),
          linePreview: line.slice(0, 200),
        }),
      );
      return;
    }

    const resultText = extractRuntimeResultText(this.plan, parsed);
    if (resultText !== undefined) {
      this.resultText = resultText;
    }

    const normalized = normalizeRuntimeEvent(this.plan.runtime, parsed);
    if (normalized) {
      const errorText = runtimeErrorMessage(normalized);
      if (errorText) {
        this.errorText = errorText;
      }
      await this.appendEvent("agent_event", normalized);
    }
  }
}

function runtimeErrorMessage(event: Record<string, unknown>): string | undefined {
  return stringValue(event, "kind") === "runtime.error" ? stringValue(event, "message") : undefined;
}

function normalizeRuntimeEvent(
  runtime: string,
  event: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  if (runtime === "claude-code") {
    return normalizeClaudeEvent(runtime, event);
  }

  if (runtime === "codex") {
    return normalizeCodexEvent(runtime, event);
  }

  const sourceType = stringValue(event, "type") ?? "event";
  return compactData({
    runtime,
    source: "stdout",
    kind: sourceType,
    sourceType,
    message:
      stringValue(event, "message") ?? stringValue(event, "result") ?? stringValue(event, "text"),
  });
}

function normalizeClaudeEvent(
  runtime: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const sourceType = stringValue(event, "type") ?? "event";
  const subtype = stringValue(event, "subtype");

  if (sourceType === "assistant") {
    const content = claudeContentSummary(event);
    return compactData({
      runtime,
      source: "stdout",
      kind: claudeAssistantKind(content.itemType),
      sourceType,
      itemType: content.itemType,
      itemId: content.itemId,
      toolName: content.toolName,
      message: content.message,
      sessionId: stringValue(event, "session_id"),
    });
  }

  if (sourceType === "system") {
    return compactData({
      runtime,
      source: "stdout",
      kind: subtype ? `runtime.${subtype}` : "runtime.system",
      sourceType,
      status: stringValue(event, "outcome"),
      message: stringValue(event, "hook_name") ?? stringValue(event, "hook_event"),
      sessionId: stringValue(event, "session_id"),
    });
  }

  if (sourceType === "result") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "agent.result",
      sourceType,
      status: subtype,
      message: stringValue(event, "result"),
      terminalReason: stringValue(event, "terminal_reason") ?? stringValue(event, "stop_reason"),
      sessionId: stringValue(event, "session_id"),
    });
  }

  if (sourceType === "rate_limit_event") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "runtime.rate_limit",
      sourceType,
      sessionId: stringValue(event, "session_id"),
    });
  }

  return compactData({
    runtime,
    source: "stdout",
    kind: `runtime.${sourceType}`,
    sourceType,
    status: subtype,
    message: stringValue(event, "message"),
    sessionId: stringValue(event, "session_id"),
  });
}

function normalizeCodexEvent(
  runtime: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const sourceType = stringValue(event, "type") ?? "event";

  if (sourceType.startsWith("item.")) {
    const item = recordValue(event, "item");
    const itemType = item ? stringValue(item, "type") : undefined;
    const lifecycle = sourceType.slice("item.".length);
    return compactData({
      runtime,
      source: "stdout",
      kind: codexItemKind(itemType, lifecycle),
      sourceType,
      itemId: item ? stringValue(item, "id") : undefined,
      itemType,
      status: item ? stringValue(item, "status") : undefined,
      message: item ? codexItemMessage(item) : undefined,
      command: item ? stringValue(item, "command") : undefined,
      exitCode: item ? numberValue(item, "exit_code") : undefined,
      server: item ? stringValue(item, "server") : undefined,
      toolName: item ? stringValue(item, "tool") : undefined,
      changes: item && Array.isArray(item.changes) ? item.changes.length : undefined,
    });
  }

  if (sourceType === "thread.started") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "thread.started",
      sourceType,
      threadId: stringValue(event, "thread_id"),
    });
  }

  if (sourceType === "turn.completed") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "agent.usage",
      sourceType,
      usage: tokenUsageFromRecord(recordValue(event, "usage")),
    });
  }

  if (sourceType === "turn.failed") {
    const error = recordValue(event, "error");
    const message = error ? extractProviderErrorMessage(stringValue(error, "message")) : undefined;
    return compactData({
      runtime,
      source: "stdout",
      kind: "runtime.error",
      sourceType,
      message,
    });
  }

  if (sourceType === "error") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "runtime.error",
      sourceType,
      message: extractProviderErrorMessage(stringValue(event, "message")),
    });
  }

  return compactData({
    runtime,
    source: "stdout",
    kind: sourceType,
    sourceType,
  });
}

function extractRuntimeResultText(plan: AgentLaunchPlan, event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  if (plan.runtime === "claude-code" && stringValue(event, "type") === "result") {
    return stringValue(event, "result");
  }

  if (plan.runtime === "codex" && stringValue(event, "type")?.startsWith("item.")) {
    const item = recordValue(event, "item");
    if (item && stringValue(item, "type") === "agent_message") {
      return stringValue(item, "text");
    }
  }

  if (plan.outputTransport.kind === "jsonl_events") {
    const eventType = stringValue(event, "type") ?? stringValue(event, "kind");
    if (eventType === plan.outputTransport.finalEvent) {
      return extractGenericResultText(event);
    }
  }

  return undefined;
}

function extractGenericResultText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const direct =
    stringValue(value, "result") ?? stringValue(value, "text") ?? stringValue(value, "message");
  if (direct !== undefined) {
    return direct;
  }

  const content = value.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => (isRecord(item) ? stringValue(item, "text") : undefined))
      .filter((item): item is string => Boolean(item))
      .join("");
    return text || undefined;
  }

  return undefined;
}

function claudeContentSummary(event: Record<string, unknown>): {
  itemType?: string;
  itemId?: string;
  toolName?: string;
  message?: string;
} {
  const message = recordValue(event, "message");
  const content = message?.content;
  if (!Array.isArray(content)) {
    return {};
  }

  const blocks = content.filter(isRecord);
  const text = blocks
    .map((block) =>
      stringValue(block, "type") === "thinking" ? undefined : stringValue(block, "text"),
    )
    .filter((value): value is string => Boolean(value))
    .join("");
  const primary = blocks.find((block) => stringValue(block, "type") !== "thinking") ?? blocks[0];
  const itemType = primary ? stringValue(primary, "type") : undefined;

  return {
    itemType,
    itemId: primary ? stringValue(primary, "id") : undefined,
    toolName: primary ? stringValue(primary, "name") : undefined,
    message: itemType === "thinking" ? undefined : text || undefined,
  };
}

function claudeAssistantKind(itemType: string | undefined): string {
  switch (itemType) {
    case "text":
      return "agent.message";
    case "thinking":
      return "agent.reasoning";
    case "tool_use":
      return "tool.started";
    case "tool_result":
      return "tool.completed";
    default:
      return "agent.message";
  }
}

function codexItemKind(itemType: string | undefined, lifecycle: string): string {
  switch (itemType) {
    case "agent_message":
      return "agent.message";
    case "reasoning":
      return "agent.reasoning";
    case "command_execution":
      return `tool.command.${lifecycle}`;
    case "file_change":
      return `file_change.${lifecycle}`;
    case "mcp_tool_call":
      return `tool.mcp.${lifecycle}`;
    case "collab_tool_call":
      return `tool.collab.${lifecycle}`;
    case "web_search":
      return `tool.web_search.${lifecycle}`;
    case "todo_list":
      return `agent.todo.${lifecycle}`;
    case "error":
      return "agent.error";
    default:
      return `item.${lifecycle}`;
  }
}

function codexItemMessage(item: Record<string, unknown>): string | undefined {
  const direct =
    stringValue(item, "text") ??
    stringValue(item, "message") ??
    stringValue(item, "aggregated_output");
  if (direct) {
    return direct;
  }

  const error = recordValue(item, "error");
  return error ? stringValue(error, "message") : undefined;
}

function extractProviderErrorMessage(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as unknown;
    if (isRecord(parsed)) {
      const direct = stringValue(parsed, "message");
      if (direct) {
        return direct;
      }
      const error = recordValue(parsed, "error");
      const nested = error ? stringValue(error, "message") : undefined;
      if (nested) {
        return nested;
      }
    }
  } catch {
    // Provider errors are often plain text; keep the original message.
  }

  return message;
}

function tokenUsageFromRecord(
  usage: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokens = numberValue(usage, "input_tokens");
  const outputTokens = numberValue(usage, "output_tokens");
  const cacheReadTokens = numberValue(usage, "cached_input_tokens");
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;

  const normalized = compactData({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
  });

  return Object.keys(normalized).length > 0 ? (normalized as Record<string, number>) : undefined;
}

function compactData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}

function recordValue(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
