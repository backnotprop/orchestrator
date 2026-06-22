# Group And Parent Interruption

Date: 2026-06-19

## Status

Draft spec.

## Intent

Make it easy to stop a whole parent/child agent run without copying every child
task ID by hand. Also make parent interruption safer: stopping a parent while
children keep running should not happen silently.

This is the next budget-safety slice after short task ID resolution.

## Current Code Shape

The task store already has enough data to do this without a new database table.

- `AgentTaskRecord.parent` stores:
  - `parentRunId`
  - `parentTaskId`
  - `parentSessionId`
  - `parentToolCallId`
- `orchestrator run --background` creates a managed parent task whose
  `taskId`, `parentRunId`, and `parentTaskId` are the same value.
- Parent-agent child launches pass both `parentRunId` and `parentTaskId` when a
  managed parent task exists.
- `packages/core/src/tasks/operations.ts` already groups `ps` rows like this:
  - an `orchestrator` parent task groups by its own `taskId`
  - children group by `parentTaskId` when present
  - otherwise children group by `parentRunId`
  - unparented tasks group under `ungrouped`
- `packages/core/src/tasks/supervisor.ts` has `interruptTask(input)`, which
  interrupts one task and now resolves short IDs before looking up the running
  process.
- `packages/cli/src/cli.ts` only supports one positional interrupt target:

  ```sh
  orchestrator interrupt <task-id|prefix>
  ```

The missing piece is a core operation that resolves a parent/group selector into
multiple task records and interrupts the non-terminal ones consistently.

## Recommendation

Build group interruption and safer parent interruption in one slice.

They should be implemented together because both require the same group
selection logic and both exist to prevent the same budget problem: a parent run
is cancelled but expensive children remain alive.

Do not create a separate group model. Reuse the group identity already implied
by task records and shown by `ps`.

## CLI Shape

Keep the current single-task command:

```sh
orchestrator interrupt <task-id|prefix>
```

Add parent plus children:

```sh
orchestrator interrupt <parent-task-id|prefix> --children
orchestrator interrupt --parent <parent-task-id|prefix> --children
```

Add group interruption:

```sh
orchestrator interrupt --group <group-id|prefix>
```

Add an explicit escape hatch for parent-only interruption:

```sh
orchestrator interrupt <parent-task-id|prefix> --task-only
```

Rules:

- A positional task ID, `--parent`, and `--group` are mutually exclusive.
- `--children` means interrupt the parent task and its non-terminal children.
- `--parent <id> --children` is equivalent to `<id> --children`.
- `--group <id>` interrupts all non-terminal tasks in that `ps` group.
- `--group ungrouped` is not supported in this slice. It is too broad.
- `--task-only` is only valid with a positional task ID.
- `--children` and `--task-only` are mutually exclusive.

## Safer Parent Interruption

Plain `interrupt <task-id>` should still interrupt one ordinary task.

If the target task is an `orchestrator` parent task and it has non-terminal
children, plain interruption should fail with a direct message:

```text
Task "abc12345" has 4 running children. Use:
  orchestrator interrupt abc12345 --children
or:
  orchestrator interrupt abc12345 --task-only
```

This keeps non-interactive use safe. There should be no prompt. Agents and
scripts need deterministic behavior.

If the parent has no non-terminal children, plain `interrupt <parent>` can
interrupt the parent task normally.

## Core API

Add a grouped interrupt operation under the core task package. This should not
live only in the CLI.

Proposed shape:

```ts
export type InterruptTasksInput = TaskStoreOptions & {
  target:
    | { kind: "task"; taskId: string; children?: boolean; taskOnly?: boolean }
    | { kind: "parent"; parentId: string; children: true }
    | { kind: "group"; groupId: string };
  reason?: string;
  signal?: NodeJS.Signals;
};

export type InterruptTasksResult = {
  target: InterruptTasksInput["target"];
  interrupted: AgentTaskRecord[];
  skipped: Array<{ task: AgentTaskRecord; reason: "terminal" }>;
  failed: Array<{ taskId: string; error: string }>;
};

export async function interruptTasks(input: InterruptTasksInput): Promise<InterruptTasksResult>;
```

`interruptTask(input)` should remain as the single-task primitive.
`interruptTasks(input)` should use it after selecting targets.

Selection helpers should live in core too:

- `taskGroupId(task: AgentTaskRecord): string`
- `resolveTaskGroupId(options, input): Promise<string>`
- `childrenForParentTask(tasks, parentTaskId): AgentTaskRecord[]`
- `tasksForGroup(tasks, groupId): AgentTaskRecord[]`

`operations.ts` should reuse `taskGroupId` so `ps` and group interruption cannot
drift.

## Selection Rules

Parent selector:

- Resolve `parentId` through `resolveTaskId`.
- Include the parent task itself.
- Include tasks where:
  - `task.parent?.parentTaskId === parentTaskId`
  - or `task.parent?.parentRunId === parentTaskId`
- Interrupt non-terminal tasks only.

Group selector:

- Match against the same group ID that `ps` uses.
- Accept exact group IDs or unique group ID prefixes.
- Include every non-terminal task in that group.
- For managed parent runs, the group should include the parent task and children.
- For foreground parent runs, there may be no parent task, so the group may only
  include children.

Ordering:

1. Interrupt the parent task first when one is present.
2. Interrupt child tasks after the parent.
3. Continue through the full selection even if one task fails.

Stopping the parent first prevents it from launching more children while the
group cancellation is in progress.

## Output

Text output should be compact and readable:

```text
interrupted 3 tasks
cancelled  abc12345  orchestrator  repo work
cancelled  def67890  codex         inspect store
skipped    1234abcd  claude-code   already succeeded
```

JSON output should be stable for agents:

```json
{
  "target": { "kind": "parent", "parentId": "abc12345", "children": true },
  "interrupted": [{ "taskId": "..." }],
  "skipped": [{ "taskId": "...", "reason": "terminal" }],
  "failed": [{ "taskId": "...", "error": "..." }]
}
```

Exit behavior:

- exit `0` when at least one task was interrupted and no interrupt attempts
  failed
- exit `1` when no matching tasks exist
- exit `1` when the parent-safety guard blocks the command
- exit `1` when any selected non-terminal task failed to interrupt

Terminal tasks in a selected group are skipped, not failures.

## Parent-Agent Tool Shape

Extend `interrupt_agent` instead of adding a second tool.

Proposed parameters:

```ts
{
  taskId?: string;
  parentId?: string;
  groupId?: string;
  children?: boolean;
  taskOnly?: boolean;
  reason?: string;
}
```

Rules match the CLI:

- exactly one of `taskId`, `parentId`, `groupId`
- `children` works with `taskId` or `parentId`
- `groupId` implies group interruption
- `taskOnly` works only with `taskId`

Return shape:

- single-task calls can keep returning `{ task }`
- multi-task calls return `{ interrupted, skipped, failed }`

This keeps the tool surface small while giving parent agents the same safe
control path as humans.

## Tests

Core tests:

- `interruptTasks({ taskId })` preserves current single-task behavior.
- `interruptTasks({ taskId, children: true })` interrupts parent and running
  children.
- parent-safety guard blocks plain parent interruption when running children
  exist.
- `taskOnly` interrupts only the parent when running children exist.
- `groupId` selects the same rows that `ps` groups together.
- group ID prefixes work and ambiguous group prefixes fail.
- terminal children are skipped, not failed.
- failures for one child do not stop attempts for later children.

CLI tests:

- `orchestrator interrupt <parent> --children --json`
- `orchestrator interrupt --parent <parent> --children --json`
- `orchestrator interrupt --group <group> --json`
- plain `orchestrator interrupt <parent>` fails when running children exist.
- `orchestrator interrupt <parent> --task-only` works.

Agent-tool tests:

- `interrupt_agent({ taskId, children: true })`
- `interrupt_agent({ parentId, children: true })`
- `interrupt_agent({ groupId })`
- invalid selector combinations fail clearly.

## Non-Goals

- No interactive prompt.
- No broad `ungrouped` kill.
- No fuzzy task or group lookup.
- No new persistent group table.
- No TUI work in this slice.
- No compact `ps --json --running` view in this slice.

## Expected Result

After this slice, the safe command for a managed parent run is obvious:

```sh
orchestrator interrupt <parent-id|prefix> --children
```

The user can also stop the exact group shown in `ps`:

```sh
orchestrator interrupt --group <group-id|prefix>
```

And plain parent interruption no longer gives a false sense that the whole run
was stopped while children continue spending tokens in the background.
