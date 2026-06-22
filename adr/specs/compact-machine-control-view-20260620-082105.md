# Compact Machine Control View

Date: 2026-06-20

## Status

Draft spec.

## Intent

Give agents and scripts a small JSON view for deciding what is running and what
can be stopped. Keep the existing human `ps` table and full `ps --json` view
intact.

This is for control. The common question is: "what tasks are active, what group
are they in, and what ID should I pass to `interrupt`?"

## Current Code Shape

`orchestrator ps` already has the right source of truth:

- `packages/core/src/tasks/operations.ts` builds `AgentTaskPsView`.
- `packages/cli/src/render-ps.ts` renders the human table.
- `packages/cli/src/cli.ts` prints the full view for `ps --json`.

The full JSON view is useful for a future TUI, but it is too large for quick
agent control. It includes duplicated row data under `rows` and `groups`, task
paths, timestamps, parent metadata, dashboard fields, and event summaries.

Do not replace it. Add a compact projection on top of the same view.

## CLI Shape

Add:

```sh
orchestrator ps --json --compact
orchestrator ps --json --compact --active
orchestrator ps --json --compact --parent <group-id|prefix>
orchestrator ps --watch --json --compact
```

Rules:

- `--compact` requires `--json`.
- `--active` means non-terminal tasks only.
- `--runtime`, `--status`, `--parent`, `--all`, and `--watch` should keep
  working.
- Common options such as `--workspace`, `--orchestrator-dir`, `--config`, and
  `--json` should work before or after the command. Agents often prepend common
  options while also executing portable args returned by compact JSON.
- `--watch --json --compact` streams one compact JSON object per refresh, just
  like current `ps --watch --json`.
- Keep full `ps --json` unchanged for UI/TUI consumers.

## JSON Shape

Return a stable, small object:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-20T15:18:49.707Z",
  "summary": {
    "tasks": 2,
    "active": 2,
    "done": 0,
    "failed": 0,
    "stopped": 0,
    "timedOut": 0
  },
  "stop": {
    "kind": "active",
    "args": ["interrupt", "--active", "--json", "--workspace", "/repo"]
  },
  "groups": [
    {
      "id": "abc12345",
      "groupId": "abc12345-full",
      "label": "repo plan",
      "status": "running",
      "tasks": 2,
      "active": 2,
      "failed": 0,
      "stopped": 0,
      "timedOut": 0,
      "tokens": 77000,
      "commands": {
        "ps": {
          "args": ["ps", "--parent", "abc12345", "--json", "--compact", "--workspace", "/repo"]
        },
        "activePs": {
          "args": [
            "ps",
            "--parent",
            "abc12345",
            "--json",
            "--compact",
            "--active",
            "--workspace",
            "/repo"
          ]
        }
      },
      "stop": {
        "kind": "group",
        "id": "abc12345",
        "args": ["interrupt", "--group", "abc12345", "--json", "--workspace", "/repo"]
      }
    }
  ],
  "tasks": [
    {
      "id": "abc12345",
      "taskId": "abc12345-full",
      "groupId": "abc12345-full",
      "group": "abc12345",
      "name": "repo plan",
      "runtime": "orchestrator",
      "status": "running",
      "active": true,
      "last": "running",
      "durationMs": 12000,
      "stop": {
        "kind": "parent",
        "id": "abc12345",
        "args": ["interrupt", "abc12345", "--children", "--json", "--workspace", "/repo"]
      }
    },
    {
      "id": "def67890",
      "taskId": "def67890-full",
      "groupId": "abc12345-full",
      "group": "abc12345",
      "name": "inspect api",
      "runtime": "codex",
      "model": "gpt-5.4-mini",
      "status": "running",
      "active": true,
      "tokens": 14000,
      "last": "reading files",
      "durationMs": 12000,
      "commands": {
        "read": {
          "args": ["read", "def67890", "--json", "--workspace", "/repo"]
        },
        "wait": {
          "args": [
            "read",
            "def67890",
            "--wait",
            "--timeout-ms",
            "300000",
            "--json",
            "--workspace",
            "/repo"
          ]
        },
        "watch": {
          "args": ["watch", "def67890", "--json", "--workspace", "/repo"]
        },
        "agentWatch": {
          "args": ["watch", "def67890", "--agent-only", "--json", "--workspace", "/repo"]
        },
        "logs": {
          "args": ["logs", "def67890", "--json", "--workspace", "/repo"]
        },
        "events": {
          "args": ["events", "def67890", "--json", "--workspace", "/repo"]
        },
        "agentEvents": {
          "args": ["events", "def67890", "--agent-only", "--json", "--workspace", "/repo"]
        }
      },
      "stop": {
        "kind": "task",
        "id": "def67890",
        "args": ["interrupt", "def67890", "--json", "--workspace", "/repo"]
      }
    }
  ]
}
```

Use both short IDs and full IDs:

- `id` is the short ID shown by human views.
- `taskId` and `groupId` are full stable IDs.
- `stop.id` should be the shortest safe value the CLI accepts.
- `exitCode` should be present when the task record has one. This lets agents
  classify failed process tasks from compact history without reading raw events.
- `stop.args` should be executable CLI arguments after the `orchestrator`
  binary name, including `--json` for a parseable result. CLI-produced JSON
  should include `--workspace` and, when needed, `--orchestrator-dir` so the
  stop command works from any current directory.
- `commands` should include executable `read`, `wait`, `watch`, `agentWatch`,
  `logs`, `events`, and `agentEvents` args for each task. `read` means
  immediate JSON read. `wait` means bounded wait for the final result. `watch`
  means the full live task stream; `agentWatch` means normalized live agent
  events only. `events` means the full task timeline; `agentEvents` means
  normalized agent events only. This lets an agent continue the task lifecycle
  without remembering CLI syntax.
- Group `commands` should include executable `ps` and `activePs` args. `ps`
  re-queries the compact view for that group. `activePs` re-queries only active
  tasks in that group.
- Top-level `stop.kind: "active"` should be present when the view contains
  active tasks. It stops all currently active tasks in the selected workspace.
- Parent task rows with running children should use `kind: "parent"` and include
  `--children`, so agents do not accidentally hit the parent-safety guard.

If usage is unavailable, omit `tokens` rather than inventing a number.

## Core Shape

Add a projection function in core:

```ts
export type AgentTaskControlView = {
  schemaVersion: 1;
  generatedAt: string;
  summary: {
    tasks: number;
    active: number;
    done: number;
    failed: number;
    stopped: number;
    timedOut: number;
  };
  stop?: AgentTaskControlStopTarget;
  groups: AgentTaskControlGroup[];
  tasks: AgentTaskControlTask[];
};

export function compactAgentTaskPsView(
  view: AgentTaskPsView,
  options?: { activeOnly?: boolean },
): AgentTaskControlView;
```

This should be a pure projection from `AgentTaskPsView`. It should not read
files, re-query task state, or create another task model.

## Parent/Group Filtering

The existing `ps --parent` filter should remain available.

For compact control, prefer accepting the same short group IDs shown in human
output. If the user passes a prefix, resolve it against the current group IDs and
fail on ambiguity. This matches how short task IDs already work.

## Output Semantics

`summary.active` is the count of non-terminal tasks.

Task `active` is true when status is not terminal:

- `queued`
- `starting`
- `running`

Task `active` is false for:

- `succeeded`
- `failed`
- `cancelled`
- `timed_out`

`failed` counts only failed tasks. Deliberately cancelled work is `stopped`.
Timed-out work is `timedOut`. Do not collapse stopped or timed-out work into
failed counts, because agents need to know whether work broke or was stopped by
an operator.

Group `stop` should be present only when the group can be interrupted by group
ID. Do not emit a group stop target for `ungrouped`, because broad ungrouped
interruption is intentionally blocked.

Task `stop` should always be present for active tasks. For ordinary tasks it
should stop that task. For active parent tasks with running children it should
stop the parent and children, because plain parent interruption is intentionally
blocked.

## Tests

Add tests for:

- `ps --json --compact` returns the compact shape.
- Compact output does not include `taskDir`, `cwd`, or duplicated group rows.
- `--active` returns only non-terminal tasks.
- `--runtime`, `--status`, and `--parent` still work with compact output.
- `ps --watch --json --compact` emits compact JSON frames.
- `--compact` without `--json` fails with a clear error.
- Leading common options work, and command-local portable args can override
  them.

## Non-Goals

This does not add a TUI.

This does not replace the full `ps --json` output.

This does not add a new persistent group model.

This does not change interruption behavior. It only makes the current control
targets easier to discover.

## Expected Result

Agents can do the common control loop without parsing a dashboard object:

1. Run `orchestrator ps --json --compact --active`.
2. Read `tasks` and `groups`.
3. Pick a task or group from the `stop` field.
4. Call `orchestrator` with `stop.args`.

Humans keep the current `ps` and `ps --watch` table. Future TUI work still uses
the full grouped task view.
