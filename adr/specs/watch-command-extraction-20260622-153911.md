# Spec: Extract `watch`

Date: 2026-06-22

## Intent

Continue reducing `packages/cli/src/cli.ts` without changing CLI behavior. Extract the `watch` command into its own command module after `read`, `logs`, and `events`.

## Scope

Create:

```text
packages/cli/src/commands/watch.ts
```

Update:

```text
packages/cli/src/cli.ts
```

No changes are expected in core task storage, runtime registry, task output capture, or command contracts.

## New Command Module

`packages/cli/src/commands/watch.ts` should export:

```ts
export type WatchOptions = {
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
  json: boolean;
  taskId: string;
  intervalMs: number;
  agentOnly: boolean;
};

export async function commandWatch(options: WatchOptions): Promise<void>;
```

Move these helpers into the same file as private functions:

- `renderWatchEvents`
- `formatWatchEvent`
- `eventDataString`
- `delay`

## `cli.ts` Changes

Import:

```ts
import { commandWatch, type WatchOptions } from "./commands/watch.ts";
```

Remove from `cli.ts`:

- local `WatchOptions`
- local `commandWatch`
- local `renderWatchEvents`
- local `formatWatchEvent`
- local `eventDataString`
- local `delay`, if no other remaining CLI code needs it

Keep in `cli.ts`:

- `parseWatchOptions`
- command dispatch
- help text
- JSON help contract
- parser error behavior

## Dependencies In `watch.ts`

Import from `@backnotprop/orchestrator-core`:

```ts
import {
  isTerminalTaskStatus as isTerminalStatus,
  readTaskRecord,
  resolveTaskId,
  type TaskEvent,
} from "@backnotprop/orchestrator-core";
```

Import from CLI modules:

```ts
import { isAgentEventLine, parseTaskEventLine } from "../task-events.ts";
import { readNewFileText } from "../task-output.ts";
import { formatInline } from "../terminal-format.ts";
```

## Behavior Requirements

Preserve:

- `watch <task-id|prefix>` follows one running task until terminal status
- short task id prefix resolution
- `--workspace` task store behavior
- `--orchestrator-dir` task store behavior
- `--interval-ms` polling interval
- human mode prints formatted task lifecycle and agent events
- human mode prints raw stdout for non-structured transports
- human mode prints stderr to stderr
- human mode suppresses raw stdout when `task.launchPlan.outputTransport.kind === "jsonl_events"`
- `--json` prints raw task event JSONL only
- `--json` suppresses raw stdout/stderr text
- `--agent-only --json` prints only normalized `agent_event` task events
- incomplete event-line buffering across file reads
- final partial event-line flush when the task exits
- existing parser errors for missing, duplicate, or unknown watch args

## Verification

Run:

```bash
pnpm run typecheck
node --experimental-strip-types --test test/cli-watch-logs.test.ts test/cli-contract.test.ts
pnpm run check
```

`test/cli-watch-logs.test.ts` is the main behavioral guard. `test/cli-contract.test.ts` ensures the command contract still exposes `watch` correctly.

## Acceptance Criteria

- `cli.ts` no longer owns `watch` execution or watch rendering helpers.
- `cli.ts` still owns `parseWatchOptions`.
- `watch.ts` owns the live task-following behavior.
- `watch` output remains unchanged.
- Full check passes.
