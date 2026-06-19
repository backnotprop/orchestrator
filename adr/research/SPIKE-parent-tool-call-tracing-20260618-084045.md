# Parent Tool-Call Tracing

Date: 2026-06-18

## Question

When a user runs `orchestrator run`, can we show live parent tool calls such
as `launch_agent` and `read_agent`, instead of only seeing the final answer?

This matters for CLI debug mode now and for a future TUI later.

## Current Shape

`orchestrator run` creates a Pi-backed parent session in
`packages/cli/src/cli.ts`. The command calls `session.prompt(...)`, waits for it
to finish, then prints the final assistant text.

The parent does not get normal file or shell tools. `packages/agent/src/session.ts`
passes `noTools: "builtin"` and exposes only our Orchestrator tools as Pi custom
tools:

- `launch_agent`
- `list_agents`
- `read_agent`
- `read_agent_events`
- `read_agent_logs`
- `interrupt_agent`

Those tools are all created in `packages/agent/src/tools.ts`. That is the
cleanest local place to observe Orchestrator job-control behavior.

Pi already persists the parent session as JSONL. In a real run, that file
contains assistant `toolCall` messages and `toolResult` messages for
`launch_agent` and `read_agent`. That proves the information exists after the
fact.

## Pi Findings

Pi has several relevant live surfaces.

`AgentSession.subscribe(...)` emits live session events. Source:
`/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts`.

The lower-level agent event type includes:

- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`

Pi extensions also have `tool_call` and `tool_result` hooks. These are powerful,
but they are not passive-only. `tool_call` can block a tool, and `tool_result`
can modify the result. Source:
`/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/extensions/types.ts`.

That is useful for Pi extensions, but it is not the best first surface for our
debug mode.

## Options

### Option A: Tail Pi Session JSONL

Read the parent session file while it is being written and render `toolCall` and
`toolResult` entries.

Pros:

- Uses the final transcript source.
- Includes exactly what Pi stores.

Cons:

- Couples Orchestrator UI to Pi's file format.
- Needs session file discovery and tailing behavior.
- Works after Pi writes entries, not necessarily at the moment our tool starts.
- Bad fit if the parent implementation changes later.

This is useful later for replay, not as the primary live trace API.

### Option B: Use Pi Session Events Directly

Subscribe to Pi events and render `tool_execution_start` and
`tool_execution_end`.

Pros:

- Live.
- Passive.
- Captures the parent model's streamed text if we want it.

Cons:

- Event shape is Pi-specific.
- It tells us tool start/end, but Orchestrator still needs its own stable event
  shape for CLI and TUI.

This is useful as a bridge, but should not be the product-level contract.

### Option C: Use Pi Extension Hooks

Install an extension that watches `tool_call` and `tool_result`.

Pros:

- Gives pre-tool and post-tool information.
- Can see tool arguments before execution.

Cons:

- Hooks are designed to alter behavior, not just observe.
- Extra extension wiring is unnecessary because our tools are already created in
  one place.
- Easier to accidentally make debug mode affect execution.

This is too much machinery for this problem.

### Option D: Wrap Our Orchestrator Tools

Add a passive trace sink to `ParentAgentToolContext`, and emit structured events
around each Orchestrator tool's `execute(...)`.

Expected events:

```ts
type ParentToolTraceEvent =
  | { kind: "tool.call"; timestamp: string; toolCallId: string; toolName: string; input: unknown }
  | {
      kind: "tool.result";
      timestamp: string;
      toolCallId: string;
      toolName: string;
      durationMs: number;
      result: unknown;
    }
  | {
      kind: "tool.error";
      timestamp: string;
      toolCallId: string;
      toolName: string;
      durationMs: number;
      error: string;
    };
```

Pros:

- Passive and owned by Orchestrator.
- Does not depend on Pi transcript parsing.
- Works because all parent tools are in one module.
- Gives CLI and TUI the same structured event stream.
- Can later be persisted to parent-run events without redesigning it.

Cons:

- Only captures Orchestrator tools, not every Pi-native event.
- Does not replace Pi session history.

This is the recommended first design.

## Recommendation

Implement a small Orchestrator-owned parent trace stream.

The parent session should accept an optional trace callback. The tool module
should call it before and after each Orchestrator tool execution. The callback
must never be able to block or mutate the tool call. If trace rendering fails,
the tool should keep running.

The CLI should expose this as a debug mode, probably:

```sh
orchestrator run --trace-tools --agent-dir ~/.pi/agent "..."
```

Trace output should go to stderr so stdout remains the parent agent's answer.

For machines and TUI, either add:

```sh
orchestrator run --trace-tools=jsonl ...
```

or keep the JSONL shape inside the package API and let the CLI renderer stay
human-readable. The package API matters more than the terminal format because
the TUI should consume events directly, not scrape terminal output.

## What This Should Achieve

When the parent launches a child and waits for it, the operator should see a
live sequence like:

```text
tool call   launch_agent runtime=codex model=gpt-5.4-mini name="hello demo"
tool result launch_agent taskId=... status=running duration=...
tool call   read_agent taskId=... wait=true timeoutMs=120000
tool result read_agent retrievalStatus=completed status=succeeded duration=...
```

The final answer still prints normally.

## Not Now

Do not make `orchestrator run` a durable background task as part of this. That
is related, but separate.

Do not build the TUI yet.

Do not parse Pi JSONL as the primary live path.

Do not use Pi extension hooks unless we later need behavior that only hooks can
provide.

## References

- `packages/cli/src/cli.ts`
- `packages/agent/src/session.ts`
- `packages/agent/src/tools.ts`
- `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/agent-session.ts`
- `/Users/ramos/oss-agents/pi/packages/coding-agent/src/core/extensions/types.ts`
- `/Users/ramos/oss-agents/pi/packages/agent/src/types.ts`
