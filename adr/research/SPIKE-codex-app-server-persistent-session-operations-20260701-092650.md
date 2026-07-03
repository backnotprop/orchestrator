# SPIKE: Codex App-Server Persistent Sessions And Goal Operations

## Question

What needs to change so Orchestrator can keep one Codex app-server agent alive,
give it normal work, start a goal, wait for that goal, then give the same Codex
agent more work?

## Desired UX

The desired flow is:

```text
Human: launch a goal to improve performance across the app by 10%.
Orchestrator: got it, I will launch Codex and give it that goal.
```

And also:

```text
Orchestrator: launch Codex.
Orchestrator: have that Codex do some tasks.
Orchestrator: decide to have that Codex do a goal.
Orchestrator: wait for the goal to finish.
Orchestrator: have that Codex do more tasks.
Orchestrator: have that Codex do another goal.
```

That is not just `goal set` on a task. It is a persistent Codex session with
multiple operations over time.

## Current Orchestrator Behavior

The current `codex-app-server` executor is still turn-shaped:

- starts `codex app-server --listen stdio://`.
- initializes the protocol client.
- opens or resumes a Codex thread.
- immediately calls `turn/start` with the launch prompt.
- waits for `turn/completed`.
- writes the result.
- marks the Orchestrator task terminal.
- closes the app-server process.

Relevant code:

- `packages/core/src/tasks/executors/protocol/codex-app-server.ts`
- `packages/core/src/tasks/executors/types.ts`
- `packages/core/src/tasks/control.ts`
- `packages/core/src/tasks/supervisor.ts`
- `packages/core/src/tasks/types.ts`

The current running-message path is useful but narrow:

- `send` only works while the task is non-terminal.
- the executor's `sendMessage` expects a current `turnId`.
- it sends `turn/steer` into the active turn.
- it cannot start a new turn after the previous one completes.

So the foundation is good, but the executor lifetime is not yet right for the
desired UX.

## Current Data Model

`AgentTaskRecord.status` is process/task level:

- `queued`
- `starting`
- `running`
- `succeeded`
- `failed`
- `cancelled`
- `timed_out`

There is no separate session state or operation state. For persistent sessions,
the task can be `running` while the Codex session is:

- starting
- idle
- running a normal turn
- running a goal
- stopping

That state should not be overloaded into terminal task statuses.

## Codex Goal Behavior

Codex app-server exposes goal RPCs:

- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`

It emits:

- `thread/goal/updated`
- `thread/goal/cleared`

Goals require persisted, non-ephemeral threads.

Codex's Python SDK has `start_goal_operation`. It does more than set metadata:

1. read the thread.
2. require that the thread is idle.
3. require that the thread is persisted.
4. reserve goal operation routing.
5. clear any previous goal.
6. set a new active goal.
7. wait for Codex to start the runtime-generated goal turn.

The SDK also treats a goal operation as a logical stream. It considers the goal
operation finished when the active physical turn has completed and the goal is
cleared or reaches a terminal provider status:

- paused
- blocked
- usage-limited
- budget-limited
- complete

This is the clearest model for Orchestrator to copy.

## Implication

The next phase should not start by adding only:

```sh
orchestrator goal set <task-id> "..."
```

That is a lower-level control surface.

The next phase should add a session-shaped `codex-app-server` mode where the
managed task stays alive while Codex is idle between operations.

## Open Design Choices

1. How to start a session

Likely:

```sh
orchestrator launch codex-app-server --session --name "performance worker"
```

The session may optionally accept an initial instruction, but it should also be
able to start with no immediate turn.

2. How to send normal work

Likely:

```sh
orchestrator send <task-id> "Inspect current performance bottlenecks."
orchestrator send <task-id> --wait "Summarize what you found."
```

For a session:

- if idle, `send` starts a new `turn/start`.
- if a turn is active, `send` steers with `turn/steer`.
- if a goal is active, `send` may steer the current goal turn only when safe.

3. How to start a goal

Likely:

```sh
orchestrator goal start <task-id> "Improve performance across the app by 10%."
orchestrator goal start <task-id> --wait "Improve performance across the app by 10%."
```

This should require an idle persisted Codex session.

4. How to wait

Likely:

```sh
orchestrator goal wait <task-id>
```

Orchestrator should wait on provider goal status and current turn completion,
not just on task completion, because the session task remains alive.

## Recommendation

Build persistent Codex app-server sessions before goal UX.

The first useful goal feature is not "goal state mutation." It is "start a
goal operation on this persistent Codex session and wait for the operation to
finish."

## References

- `packages/core/src/tasks/executors/protocol/codex-app-server.ts`
- `packages/core/src/tasks/control.ts`
- `packages/core/src/tasks/supervisor.ts`
- `packages/core/src/tasks/types.ts`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/client.py`
- `/Users/ramos/oss-agents/codex/sdk/python/src/openai_codex/_goal.py`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/runtime.rs`
- `adr/research/SPIKE-codex-goals-support-20260701-072738.md`
- `adr/specs/codex-goal-support-20260701-074950.md`
