# Spec: Extract `read`, `logs`, and `events`

Date: 2026-06-22

## Intent

Continue shrinking `packages/cli/src/cli.ts` without changing behavior. Move the task inspection commands into their own command module while keeping parsing in `cli.ts` for now.

## Scope

Create:

```text
packages/cli/src/commands/task-inspection.ts
packages/cli/src/task-events.ts
```

Update:

```text
packages/cli/src/cli.ts
packages/cli/src/task-output.ts
```

## New Command Module

`packages/cli/src/commands/task-inspection.ts` should export:

```ts
export type LogStream = "stdout" | "stderr" | "all";

export type ReadOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  taskIds: readonly string[];
  maxBytes?: number;
  wait: boolean;
  timeoutMs?: number;
  intervalMs?: number;
  compact: boolean;
};

export type LogsOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  taskId: string;
  stream: LogStream;
  maxBytes?: number;
  follow: boolean;
  compact: boolean;
};

export type EventsOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  taskId: string;
  maxBytes?: number;
  agentOnly: boolean;
  compact: boolean;
};

export async function commandRead(options: ReadOptions): Promise<void>;
export async function commandLogs(options: LogsOptions): Promise<void>;
export async function commandEvents(options: EventsOptions): Promise<void>;
```

Move these execution helpers into the same file as private functions:

- `commandReadBatch`
- `taskBatchStopTarget`
- `activeBelongsToParent`
- `readTaskForOptions`
- `onlyTaskId`
- `readBatchSummary`
- `batchTaskReadJsonPayload`
- `followLogs`

## Shared Helper Updates

Move `readNewFileText` from `cli.ts` to `task-output.ts` and export it.

Create `task-events.ts`:

```ts
import type { TaskEvent } from "@backnotprop/orchestrator-core";

export function parseTaskEventLine(line: string): TaskEvent | undefined;
export function isAgentEventLine(line: string): boolean;
```

Update `commandEvents` to use `parseTaskEventLine` and `isAgentEventLine`.

Update the remaining `watch` code in `cli.ts` to use the same helpers. Keep `renderWatchEvents`, `formatWatchEvent`, and `eventDataString` in `cli.ts` until the later `watch` extraction.

## `cli.ts` Changes

Import:

```ts
import {
  commandEvents,
  commandLogs,
  commandRead,
  type EventsOptions,
  type LogsOptions,
  type LogStream,
  type ReadOptions,
} from "./commands/task-inspection.ts";
```

Remove from `cli.ts`:

- `ReadOptions`
- `LogsOptions`
- `EventsOptions`
- `LogStream`
- `commandRead`
- `commandReadBatch`
- `commandLogs`
- `followLogs`
- `commandEvents`
- read/logs/events private helpers listed above
- local `readNewFileText`
- local `parseEventLine`
- local `isAgentEventLine`

Keep in `cli.ts`:

- `parseReadOptions`
- `parseLogsOptions`
- `parseEventsOptions`
- `parseLogStream`
- `commandWatch`
- watch rendering helpers

## Behavior Requirements

Preserve:

- `read <id>` human output
- `read <id> --json`
- `read <id> --json --compact`
- `read <id> --wait --json`
- batch `read <id> <id> --json --compact`
- read timeout behavior and `retrievalStatus`
- parent-safe stop target behavior for active batch reads
- `logs <id>` raw stdout/stderr behavior
- `logs <id> --stream stdout|stderr|all`
- `logs <id> --json`
- `logs <id> --json --compact`
- `logs <id> --follow`
- `logs --follow` rejection with `--json`
- `events <id>` raw event output
- `events <id> --agent-only`
- `events <id> --json`
- `events <id> --json --compact`
- malformed event lines skipped in parsed event output
- current error messages and machine-readable error shape

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-read.test.ts test/cli-watch-logs.test.ts test/cli-interrupt.test.ts test/cli-contract.test.ts
pnpm run check
```

`test/cli-watch-logs.test.ts` matters because `watch` will keep using shared event/file helpers even though it is not extracted in this slice.

## Acceptance Criteria

- `cli.ts` no longer owns `read`, `logs`, or `events` execution.
- `cli.ts` still owns parsing for those commands.
- `task-inspection.ts` owns task inspection execution.
- `watch` behavior is unchanged.
- Full check passes.
