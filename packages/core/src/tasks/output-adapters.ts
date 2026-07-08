import { appendFile } from "node:fs/promises";
import type { AgentLaunchPlan } from "../runtime/index.ts";
import type { TaskEvent, TaskPaths, TaskProviderMetadata, TaskUsage } from "./types.ts";
import { normalizeTaskUsage, usageWithUpdatedAt, type NormalizedTaskUsage } from "./usage.ts";

export type RuntimeOutputAdapterResult = {
  resultText?: string;
  errorText?: string;
  usage?: NormalizedTaskUsage;
  failed?: boolean;
  fallbackToStdout?: boolean;
};

export type RuntimeOutputAdapter = {
  onStdoutChunk(chunk: Buffer): Promise<void>;
  onStderrChunk(chunk: Buffer): Promise<void>;
  finalize(): Promise<RuntimeOutputAdapterResult>;
};

type AppendEvent = (type: TaskEvent["type"], data?: Record<string, unknown>) => Promise<TaskEvent>;
type UsageSink = (usage: TaskUsage) => Promise<void>;
type ProviderSink = (provider: TaskProviderMetadata) => Promise<void>;

export function createRuntimeOutputAdapter(input: {
  plan: AgentLaunchPlan;
  paths: TaskPaths;
  appendEvent: AppendEvent;
  onUsage?: UsageSink;
  onProvider?: ProviderSink;
}): RuntimeOutputAdapter {
  switch (input.plan.outputTransport.kind) {
    case "jsonl_events":
      return new JsonlRuntimeOutputAdapter(
        input.plan,
        input.paths,
        input.appendEvent,
        input.onUsage,
        input.onProvider,
      );
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
    return { fallbackToStdout: true };
  }
}

class StdoutJsonOutputAdapter implements RuntimeOutputAdapter {
  private stdout = "";
  private usage: NormalizedTaskUsage | undefined;

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
      this.usage = extractGenericUsage(parsed, {
        source: "runtime",
        scope: "task",
        final: true,
      });
      return {
        ...(resultText !== undefined ? { resultText } : {}),
        ...(this.usage ? { usage: this.usage } : {}),
      };
    } catch {
      return {};
    }
  }
}

class JsonlRuntimeOutputAdapter implements RuntimeOutputAdapter {
  private stdoutRemainder = "";
  private resultText: string | undefined;
  private errorText: string | undefined;
  private usage: NormalizedTaskUsage | undefined;
  private parseErrorCount = 0;
  private eventCount = 0;
  private readonly plan: AgentLaunchPlan;
  private readonly paths: TaskPaths;
  private readonly appendEvent: AppendEvent;
  private readonly onUsage: UsageSink | undefined;
  private readonly onProvider: ProviderSink | undefined;

  constructor(
    plan: AgentLaunchPlan,
    paths: TaskPaths,
    appendEvent: AppendEvent,
    onUsage: UsageSink | undefined,
    onProvider: ProviderSink | undefined,
  ) {
    this.plan = plan;
    this.paths = paths;
    this.appendEvent = appendEvent;
    this.onUsage = onUsage;
    this.onProvider = onProvider;
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
      ...this.finalError(),
      ...(this.usage ? { usage: this.usage } : {}),
      fallbackToStdout: false,
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
      this.parseErrorCount += 1;
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

    this.eventCount += 1;
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
      const provider = providerMetadataFromRuntimeEvent(this.plan.runtime, normalized);
      const mismatch = providerMetadataMismatch(this.plan.resume, provider);
      if (mismatch) {
        this.errorText = mismatch;
        await this.appendEvent(
          "agent_event",
          compactData({
            runtime: this.plan.runtime,
            source: "stdout",
            kind: "runtime.error",
            message: mismatch,
          }),
        );
      }
      const event = await this.appendEvent("agent_event", normalized);
      if (provider) {
        await this.onProvider?.(provider);
      }
      const usage = normalizeTaskUsage(normalized.usage, { updatedAt: event.ts });
      if (usage) {
        this.usage = usage;
        await this.onUsage?.(usageWithUpdatedAt(usage, event.ts));
      }
    }
  }

  private finalError(): Pick<RuntimeOutputAdapterResult, "errorText" | "failed"> {
    if (this.errorText !== undefined) {
      return { errorText: this.errorText, failed: true };
    }

    if (this.resultText !== undefined) {
      return {};
    }

    if (this.parseErrorCount > 0) {
      return {
        errorText: `Runtime "${this.plan.runtime}" emitted malformed JSONL and no final result.`,
        failed: true,
      };
    }

    if (this.eventCount > 0) {
      return {
        errorText: `Runtime "${this.plan.runtime}" did not emit final event "${this.finalEventName()}".`,
        failed: true,
      };
    }

    return {
      errorText: `Runtime "${this.plan.runtime}" did not emit structured output.`,
      failed: true,
    };
  }

  private finalEventName(): string {
    return this.plan.outputTransport.kind === "jsonl_events"
      ? this.plan.outputTransport.finalEvent
      : "final";
  }
}

function providerMetadataFromRuntimeEvent(
  runtime: string,
  event: Record<string, unknown>,
): TaskProviderMetadata | undefined {
  if (runtime === "codex") {
    const threadId = stringValue(event, "threadId");
    return threadId ? { provider: "codex", threadId } : undefined;
  }

  if (runtime === "claude-code") {
    const sessionId = stringValue(event, "sessionId");
    return sessionId ? { provider: "claude-code", sessionId } : undefined;
  }

  if (runtime === "copilot") {
    const sessionId = stringValue(event, "sessionId");
    return sessionId ? { provider: "copilot", sessionId } : undefined;
  }

  return undefined;
}

function providerMetadataMismatch(
  expected: AgentLaunchPlan["resume"] | undefined,
  actual: TaskProviderMetadata | undefined,
): string | undefined {
  if (!expected || !actual) {
    return undefined;
  }

  switch (expected.provider) {
    case "codex":
      return actual.threadId && actual.threadId !== expected.threadId
        ? `Codex resumed thread "${actual.threadId}" but Orchestrator requested "${expected.threadId}".`
        : undefined;
    case "claude-code":
      return actual.sessionId && actual.sessionId !== expected.sessionId
        ? `Claude Code resumed session "${actual.sessionId}" but Orchestrator requested "${expected.sessionId}".`
        : undefined;
    case "copilot":
      return actual.sessionId && actual.sessionId !== expected.sessionId
        ? `Copilot resumed session "${actual.sessionId}" but Orchestrator requested "${expected.sessionId}".`
        : undefined;
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

  if (runtime === "copilot") {
    return normalizeCopilotEvent(runtime, event);
  }

  const sourceType = stringValue(event, "type") ?? "event";
  const usage = extractGenericUsage(event, {
    scope: "task",
    source: "runtime",
    ...(sourceType === "final" ? { final: true } : {}),
  });
  if (sourceType === "usage" || sourceType === "agent.usage") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "agent.usage",
      sourceType,
      usage,
    });
  }

  if (sourceType === "error" || sourceType === "runtime.error" || sourceType === "agent.error") {
    const error = recordValue(event, "error");
    return compactData({
      runtime,
      source: "stdout",
      kind: "runtime.error",
      sourceType,
      message:
        extractProviderErrorMessage(stringValue(event, "message")) ??
        (error ? stringValue(error, "message") : undefined),
      usage,
    });
  }

  return compactData({
    runtime,
    source: "stdout",
    kind: sourceType === "final" ? "agent.result" : sourceType,
    sourceType,
    message:
      stringValue(event, "message") ?? stringValue(event, "result") ?? stringValue(event, "text"),
    usage,
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
    const message = recordValue(event, "message");
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
      usage: extractClaudeUsage(message ? message.usage : undefined, {
        source: "provider",
        scope: "turn",
        final: false,
      }),
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
      usage: extractClaudeResultUsage(event),
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
      usage: extractCodexUsage(recordValue(event, "usage"), {
        source: "provider",
        scope: "task",
        final: true,
      }),
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

function normalizeCopilotEvent(
  runtime: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const sourceType = stringValue(event, "type") ?? "event";
  const data = recordValue(event, "data");
  const result = recordValue(event, "result") ?? data;
  const sessionId =
    stringValue(event, "sessionId") ??
    stringValue(event, "session_id") ??
    (data ? stringValue(data, "sessionId") : undefined) ??
    (result ? stringValue(result, "sessionId") : undefined);

  if (sourceType === "assistant.message") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "agent.message",
      sourceType,
      sessionId,
      model: data ? stringValue(data, "model") : undefined,
      message: data ? stringValue(data, "content") : undefined,
      usage: extractCopilotUsage(data, {
        source: "provider",
        scope: "turn",
        final: false,
      }),
    });
  }

  if (sourceType === "assistant.message_delta") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "agent.message_delta",
      sourceType,
      sessionId,
      message: data
        ? (stringValue(data, "content") ??
          stringValue(data, "deltaContent") ??
          stringValue(data, "delta") ??
          stringValue(data, "text"))
        : undefined,
    });
  }

  if (sourceType === "assistant.turn_start") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "agent.turn.started",
      sourceType,
      sessionId,
      model: data ? stringValue(data, "model") : undefined,
      turnId: data ? stringValue(data, "turnId") : undefined,
    });
  }

  if (sourceType === "assistant.turn_end") {
    return compactData({
      runtime,
      source: "stdout",
      kind: "agent.turn.completed",
      sourceType,
      sessionId,
      model: data ? stringValue(data, "model") : undefined,
      turnId: data ? stringValue(data, "turnId") : undefined,
    });
  }

  if (sourceType === "result") {
    const exitCode = result ? numberValue(result, "exitCode") : numberValue(event, "exitCode");
    const usage = result ? recordValue(result, "usage") : recordValue(event, "usage");
    const message =
      (result ? stringValue(result, "message") : undefined) ??
      stringValue(event, "message") ??
      (result ? extractProviderErrorMessage(stringValue(result, "error")) : undefined);

    if (exitCode !== undefined && exitCode !== 0) {
      return compactData({
        runtime,
        source: "stdout",
        kind: "runtime.error",
        sourceType,
        sessionId,
        exitCode,
        message: message ?? `Copilot exited with code ${exitCode}.`,
        premiumRequests: usage ? numberValue(usage, "premiumRequests") : undefined,
        sessionDurationMs: usage ? numberValue(usage, "sessionDurationMs") : undefined,
        totalApiDurationMs: usage ? numberValue(usage, "totalApiDurationMs") : undefined,
        usage: extractCopilotUsage(usage, {
          source: "provider",
          scope: "task",
          final: true,
        }),
      });
    }

    return compactData({
      runtime,
      source: "stdout",
      kind: "agent.result",
      sourceType,
      sessionId,
      status: exitCode === undefined ? undefined : exitCode === 0 ? "succeeded" : "failed",
      exitCode,
      message,
      premiumRequests: usage ? numberValue(usage, "premiumRequests") : undefined,
      sessionDurationMs: usage ? numberValue(usage, "sessionDurationMs") : undefined,
      totalApiDurationMs: usage ? numberValue(usage, "totalApiDurationMs") : undefined,
      usage: extractCopilotUsage(usage, {
        source: "provider",
        scope: "task",
        final: true,
      }),
    });
  }

  if (sourceType === "error") {
    const error = recordValue(event, "error");
    return compactData({
      runtime,
      source: "stdout",
      kind: "runtime.error",
      sourceType,
      sessionId,
      message:
        extractProviderErrorMessage(stringValue(event, "message")) ??
        (error ? stringValue(error, "message") : undefined),
    });
  }

  return compactData({
    runtime,
    source: "stdout",
    kind: `runtime.${sourceType}`,
    sourceType,
    sessionId,
    status: data ? stringValue(data, "status") : undefined,
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

  if (plan.runtime === "copilot" && stringValue(event, "type") === "assistant.message") {
    const data = recordValue(event, "data");
    return data ? stringValue(data, "content") : undefined;
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

function extractGenericUsage(
  value: unknown,
  defaults: Partial<Pick<NormalizedTaskUsage, "source" | "scope" | "final">> = {},
): NormalizedTaskUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizeTaskUsage(recordValue(value, "usage") ?? value, { defaults });
}

function extractClaudeResultUsage(event: Record<string, unknown>): NormalizedTaskUsage | undefined {
  const defaults = {
    source: "provider" as const,
    scope: "task" as const,
    final: true,
  };
  const usage = extractClaudeUsage(event.usage, defaults);
  const costUsd =
    numberValue(event, "total_cost_usd") ??
    numberValue(event, "totalCostUsd") ??
    numberValue(event, "cost_usd") ??
    numberValue(event, "costUsd");

  if (!usage) {
    return costUsd === undefined ? undefined : { costUsd, ...defaults };
  }

  return {
    ...usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function extractClaudeUsage(
  value: unknown,
  defaults: Partial<Pick<NormalizedTaskUsage, "source" | "scope" | "final">> = {},
): NormalizedTaskUsage | undefined {
  const source = isRecord(value) ? (recordValue(value, "usage") ?? value) : undefined;
  if (!source) {
    return undefined;
  }

  const usage = normalizeTaskUsage(
    compactData({
      inputTokens: numberValue(source, "inputTokens") ?? numberValue(source, "input_tokens"),
      outputTokens: numberValue(source, "outputTokens") ?? numberValue(source, "output_tokens"),
      cacheReadTokens:
        numberValue(source, "cacheReadTokens") ??
        numberValue(source, "cache_read_tokens") ??
        numberValue(source, "cacheRead") ??
        numberValue(source, "cache_read") ??
        numberValue(source, "cache_read_input_tokens"),
      cacheWriteTokens:
        numberValue(source, "cacheWriteTokens") ??
        numberValue(source, "cache_write_tokens") ??
        numberValue(source, "cacheWrite") ??
        numberValue(source, "cache_write") ??
        numberValue(source, "cache_creation_input_tokens"),
      reasoningTokens:
        numberValue(source, "reasoningTokens") ?? numberValue(source, "reasoning_tokens"),
      totalTokens: numberValue(source, "totalTokens") ?? numberValue(source, "total_tokens"),
      costUsd: numberValue(source, "costUsd") ?? numberValue(source, "cost_usd"),
      source: stringValue(source, "source"),
      scope: stringValue(source, "scope"),
      final: booleanValue(source, "final"),
    }),
    { defaults },
  );
  if (!usage) {
    return undefined;
  }
  const hasExplicitTotal =
    numberValue(source, "totalTokens") !== undefined ||
    numberValue(source, "total_tokens") !== undefined;

  return {
    ...usage,
    totalTokens: hasExplicitTotal ? usage.totalTokens : sumKnownTokens(usage),
  };
}

function sumKnownTokens(usage: NormalizedTaskUsage): number | undefined {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
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

function extractCodexUsage(
  usage: Record<string, unknown> | undefined,
  defaults: Partial<Pick<NormalizedTaskUsage, "source" | "scope" | "final">> = {},
): NormalizedTaskUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return normalizeTaskUsage(
    compactData({
      inputTokens: numberValue(usage, "inputTokens") ?? numberValue(usage, "input_tokens"),
      outputTokens: numberValue(usage, "outputTokens") ?? numberValue(usage, "output_tokens"),
      cacheReadTokens:
        numberValue(usage, "cacheReadTokens") ??
        numberValue(usage, "cache_read_tokens") ??
        numberValue(usage, "cacheRead") ??
        numberValue(usage, "cache_read") ??
        numberValue(usage, "cached_input_tokens"),
      cacheWriteTokens:
        numberValue(usage, "cacheWriteTokens") ??
        numberValue(usage, "cache_write_tokens") ??
        numberValue(usage, "cacheWrite") ??
        numberValue(usage, "cache_write"),
      reasoningTokens:
        numberValue(usage, "reasoningTokens") ??
        numberValue(usage, "reasoning_tokens") ??
        numberValue(usage, "reasoningOutputTokens") ??
        numberValue(usage, "reasoning_output_tokens"),
      totalTokens: numberValue(usage, "totalTokens") ?? numberValue(usage, "total_tokens"),
      costUsd: numberValue(usage, "costUsd") ?? numberValue(usage, "cost_usd"),
      source: stringValue(usage, "source"),
      scope: stringValue(usage, "scope"),
      final: booleanValue(usage, "final"),
    }),
    { defaults },
  );
}

function extractCopilotUsage(
  usage: Record<string, unknown> | undefined,
  defaults: Partial<Pick<NormalizedTaskUsage, "source" | "scope" | "final">> = {},
): NormalizedTaskUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return normalizeTaskUsage(
    compactData({
      inputTokens: numberValue(usage, "inputTokens") ?? numberValue(usage, "input_tokens"),
      outputTokens: numberValue(usage, "outputTokens") ?? numberValue(usage, "output_tokens"),
      cacheReadTokens:
        numberValue(usage, "cacheReadTokens") ?? numberValue(usage, "cache_read_tokens"),
      cacheWriteTokens:
        numberValue(usage, "cacheWriteTokens") ?? numberValue(usage, "cache_write_tokens"),
      reasoningTokens:
        numberValue(usage, "reasoningTokens") ?? numberValue(usage, "reasoning_tokens"),
      totalTokens: numberValue(usage, "totalTokens") ?? numberValue(usage, "total_tokens"),
      source: stringValue(usage, "source"),
      scope: stringValue(usage, "scope"),
      final: booleanValue(usage, "final"),
    }),
    { defaults },
  );
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

function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
