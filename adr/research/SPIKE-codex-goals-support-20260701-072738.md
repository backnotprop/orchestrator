# SPIKE: Codex goals support

## Summary

Codex has a real goal system, but the external control surface is app-server first.
The codebase exposes explicit JSON-RPC methods for setting, reading, and clearing a thread goal, plus goal update/clear notifications. The same goal model is also exposed to the agent runtime as `get_goal`, `create_goal`, and `update_goal` function tools, but in this repo those tools are installed through the app-server extension path, not through the TypeScript SDK or `codex exec` wrapper.

## Relevant files

- `codex-rs/app-server-protocol/src/protocol/common.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- `codex-rs/app-server/src/request_processors/thread_goal_processor.rs`
- `codex-rs/app-server/src/extensions.rs`
- `codex-rs/ext/goal/src/{api.rs,spec.rs,tool.rs,extension.rs,runtime.rs}`
- `codex-rs/app-server/README.md`
- `codex-rs/tui/src/app_server_session.rs`
- `codex-rs/tui/src/app/thread_goal_actions.rs`
- `sdk/typescript/src/{codex.ts,exec.ts,thread.ts}`
- `sdk/python/src/openai_codex/{client.py,_message_router.py}`

## Findings

1. The app-server protocol defines stable goal RPCs:
   `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`, plus
   `thread/goal/updated` and `thread/goal/cleared`.
   The protocol types are `ThreadGoal`, `ThreadGoalStatus`, `ThreadGoalSetParams`,
   `ThreadGoalGetParams`, and `ThreadGoalClearParams`.

2. The goal data model is persisted and timestamped.
   `ThreadGoal` carries `threadId`, `objective`, `status`, optional `tokenBudget`,
   `tokensUsed`, `timeUsedSeconds`, `createdAt`, and `updatedAt`.
   Status values are `active`, `paused`, `blocked`, `usageLimited`,
   `budgetLimited`, and `complete`.

3. `thread_goal_processor.rs` is the real server implementation.
   It gates all goal RPCs on `Feature::Goals`, rejects ephemeral threads,
   reconciles the rollout before mutation, persists through `GoalService`,
   and emits goal notifications in listener order.

4. `GoalService` in `ext/goal/src/api.rs` is the shared persistence/runtime layer.
   It validates objectives and budgets, inserts or updates goals in sqlite/state,
   clears goals, and applies runtime effects when a live thread is attached.

5. The agent-facing goal tools exist as Responses API tools.
   `spec.rs` defines `get_goal`, `create_goal`, and `update_goal`.
   `tool.rs` shows the behavior: `create_goal` starts an active goal and fails if
   an unfinished goal already exists; `update_goal` only allows `complete` or
   `blocked`; `get_goal` is read-only.

6. Those tools are installed through the app-server extension path.
   `app-server/src/extensions.rs` calls `codex_goal_extension::install_with_backend`.
   `GoalExtension::tools()` only exposes the tools when the runtime says goals
   are enabled and visible for that thread.

7. I found no direct goal API in the TypeScript SDK.
   `sdk/typescript/src/codex.ts`, `thread.ts`, and `exec.ts` only expose
   thread start/resume and generic turn execution through `codex exec`.
   A search of `sdk/typescript/src` found no goal-specific methods.

8. I also found no exec-CLI goal command surface.
   The exec wrapper just forwards thread options into `codex exec`; it does not
   offer goal RPCs or a goal-specific client method. Any goal changes in an exec
   session would have to happen indirectly through the agent using the goal tools.

9. The TUI is a thin client over app-server goal RPCs.
   `tui/src/app_server_session.rs` exposes typed `thread_goal_get`,
   `thread_goal_set`, and `thread_goal_clear`, and `tui/src/app/thread_goal_actions.rs`
   drives `/goal` UI actions through those calls.

## Implications for Orchestrator

- If Orchestrator needs programmatic goal control, the safe integration target is
  app-server JSON-RPC, not `codex exec`.
- If Orchestrator wants goal updates to appear in the agent loop, it should treat
  the goal tools as runtime-internal capabilities, not as an external SDK API.
- Goal-aware UX should subscribe to `thread/goal/updated` and `thread/goal/cleared`
  so local state stays aligned with the persisted thread goal.
- Any support for ephemeral threads should be rejected up front; Codex already
  treats them as unsupported for goals.

## Main-agent verification

I verified the sub-agent findings against the Codex source after the spike:

- `app-server-protocol/src/protocol/common.rs` defines `thread/goal/set`,
  `thread/goal/get`, `thread/goal/clear`, `thread/goal/updated`, and
  `thread/goal/cleared`; protocol tests mark those methods and notifications as
  non-experimental.
- `app-server/src/request_processors/thread_goal_processor.rs` is the server-side
  implementation. It checks the goals feature flag, rejects ephemeral threads,
  reconciles stored rollout state, writes through `GoalService`, and emits
  ordered goal notifications.
- `ext/goal/src/spec.rs` and `ext/goal/src/tool.rs` define the agent-facing
  `get_goal`, `create_goal`, and `update_goal` tools. `update_goal` only lets
  the agent mark a goal `complete` or `blocked`; pause/resume/budget/usage
  states are controlled outside the agent tool.
- `sdk/python/src/openai_codex/client.py` wraps the app-server goal RPCs and has
  `start_goal_operation`, which requires an idle persisted thread, clears any
  existing goal, sets the new active goal, and waits for the goal-driven turn to
  start.

Conclusion: Codex goals are real and app-server-backed. Orchestrator should only
add first-class goal support on top of `codex-app-server` sessions with stored
thread metadata, not on top of one-shot `codex exec` tasks.

## Open questions

- Should Orchestrator call app-server directly for goal state, or only surface
  goals when connected to a Codex app-server session?
- Does the product want a first-class exec-side goal API, or is the current
  app-server-only surface enough?
- Do we want to mirror Codex’s `blocked`/`complete` constraint in Orchestrator,
  or expose a broader goal status model and translate at the boundary?
