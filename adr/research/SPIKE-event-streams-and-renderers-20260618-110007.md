# SPIKE: Event Streams and Human Renderers

Date: 2026-06-18

## Question

Are we making the right call by treating Orchestrator's live output as
structured events first, with human CLI output, JSONL, and the future TUI as
renderers over those events?

This spike checked local references for Pi, Claude-style agent output, Codex,
and OpenCode.

## Short Answer

Yes.

The common pattern is:

1. Emit structured events for what actually happened.
2. Keep stable ids for runs, tool calls, tasks, and child agents.
3. Record lifecycle boundaries: started, progress/delta, ended, failed.
4. Keep final answers separate from logs and progress.
5. Render human output as a view over the event stream, not as the source of
   truth.

Our current direction matches that pattern. The next improvement should be a
stronger event contract, not a prettier terminal format first.

## Pi Findings

Pi has a generic event stream abstraction with async iteration and a final
result promise. Assistant streams include start, text deltas, thinking deltas,
tool-call start/delta/end, done, and error events.

Pi's coding-agent session also emits live session events and exposes
tool-execution start/update/end. Tool definitions separate execution from
rendering: tools provide `execute(...)`, optional `renderCall`, and optional
`renderResult`.

That is the important split for us: execution creates facts; renderers decide
how to display them.

Relevant references:

- `/Users/ramos/oss-agents/pi/packages/ai/src/utils/event-stream.ts`
- `/Users/ramos/oss-agents/pi/packages/ai/src/types.ts`
- `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts`
- `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`
- `/Users/ramos/oss-agents/pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

## Claude-Style Findings

The Claude-style reference uses an adapter between SDK messages and display
messages. It does not blindly print every event. It ignores some noisy events,
logs unknown events for debugging, bounds progress display, and prefers clean
final assistant output over raw transcripts when reading task output.

Background task progress includes useful task metadata such as task id, tool id,
description, token counts, tool counts, last tool name, and summary.

That supports two choices for Orchestrator:

- `read_agent` should return clean final output, not raw logs.
- human trace output should summarize and bound progress instead of dumping
  every low-level event.

Relevant references:

- `/Users/ramos/oss-agents/cc-open/remote/sdkMessageAdapter.ts`
- `/Users/ramos/oss-agents/cc-open/tools/AgentTool/UI.tsx`
- `/Users/ramos/oss-agents/cc-open/tools/TaskOutputTool/TaskOutputTool.tsx`
- `/Users/ramos/oss-agents/cc-open/utils/task/sdkProgress.ts`
- `/Users/ramos/oss-agents/cc-open/utils/task/TaskOutput.ts`

## Codex Findings

Codex treats protocol events as a first-class product surface. The app-server
protocol has generated TypeScript types for thread items, item lifecycle events,
command output deltas, MCP tool progress, and token usage updates.

Codex also models multi-agent presentation state explicitly. Its TUI has types
for agent picker rows, sub-agent activity display, agent metadata, spawn
requests, running/closed state, and keyboard switching between agents.

The useful lesson is not to copy the TUI. The useful lesson is that multi-agent
views need a real state model behind them.

Relevant references:

- `/Users/ramos/oss-agents/codex/codex-rs/tui/src/multi_agents.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/tui/src/tui/event_stream.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/McpToolCallProgressNotification.ts`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/schema/typescript/v2/ItemStartedNotification.ts`

## OpenCode Findings

OpenCode has a durable event system with typed definitions, sequence numbers,
aggregate ids, versioned event types, replay support, projectors, listeners, and
sync handlers.

Its session events are split into explicit domains:

- session movement and prompt lifecycle;
- model and agent switching;
- step started/ended/failed with cost and token data;
- text started/delta/ended;
- reasoning started/delta/ended;
- tool input started/delta/ended;
- tool called/progress/success/failed;
- compaction started/delta/ended.

It also marks some deltas as live-only while keeping ended events as the
replayable full-value boundary. Tool progress is specifically described as
bounded running-tool state, not every stdout/stderr chunk.

That is directly relevant to Orchestrator. We should not persist or render every
tiny detail as equally important. We need durable summary events plus bounded
live progress.

Relevant references:

- `/Users/ramos/oss-agents/opencode/packages/core/src/event.ts`
- `/Users/ramos/oss-agents/opencode/packages/core/src/session/event.ts`
- `/Users/ramos/oss-agents/opencode/packages/tui/src/context/event.ts`
- `/Users/ramos/oss-agents/opencode/packages/tui/src/util/tool-display.ts`

## Cross-System Patterns

The same ideas show up across the references:

- Structured events are the source of truth.
- Human output is a renderer, not a contract.
- Lifecycle pairs or triples are normal: started, progress/delta, ended/failed.
- Tool calls need stable ids.
- Child/background tasks need stable task ids.
- Token usage belongs in normalized state when the runtime exposes it.
- Progress should be bounded, summarized, or throttled.
- Final answers should be separate from raw logs.
- Unknown or extra events should not break human rendering.
- Serious interfaces eventually need a state reducer, not just a log tail.

## Recommendation For Orchestrator

Keep the current direction:

- default `orchestrator run` prints only the final answer;
- `--trace-tools` renders live parent tool activity for humans;
- `--stream-json` emits machine-readable JSONL;
- future CLI/TUI views consume the same event stream.

For the next slice, strengthen the event model before polishing the display.

Add or standardize these fields on run-stream events:

- `schemaVersion`;
- `seq`;
- `timestamp`;
- `runId`;
- `toolCallId`, when relevant;
- `taskId`, when relevant;
- `parentTaskId` or `parentRunId`, when relevant;
- consistent `error` shape.

Then model the main lifecycle clearly:

- `run.started`;
- `tool.call`;
- `tool.progress`;
- `tool.result`;
- `tool.error`;
- `task.started`;
- `task.status`;
- `task.usage`;
- `task.finished`;
- `run.final`;
- `run.error`.

Once that exists, build a small reducer that turns the stream into current
state. That reducer is what powers:

- prettier terminal trace output;
- `orchestrator list --watch` or similar;
- the future TUI;
- tests that assert behavior without scraping prose.

## What This Confirms

Our recent choices are aligned with mature agent systems:

- wrapping Orchestrator tools to emit trace events;
- adding wait progress for long `read_agent` calls;
- keeping JSONL separate from human terminal output;
- planning a live agent view with token counts from runtime adapters;
- avoiding a separate job model for the TUI.

The biggest gap is not conceptual. The gap is hardening the event contract so
multiple renderers can depend on it.

## Not Now

Do not build the TUI yet.

Do not invent a large display framework before the event shape is stable.

Do not treat terminal text as an API.

Do not require every runtime to provide token usage. Store it when available and
show `unknown` when unavailable.

Do not persist every stream delta as durable task history. Keep raw logs
available, but promote bounded semantic events into the task event stream.
