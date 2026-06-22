# SPIKE: Returned command args

Date: 2026-06-22

## Question

How should Orchestrator reduce noisy returned command arrays when workspace
paths are long, without breaking the portable command contract agents already
use?

## Current Behavior

Compact JSON outputs return executable command arrays:

```json
{
  "commands": {
    "waitPreview": {
      "args": [
        "read",
        "abc12345",
        "--wait",
        "--timeout-ms",
        "300000",
        "--max-bytes",
        "16000",
        "--json",
        "--compact",
        "--workspace",
        "/very/long/workspace/path"
      ]
    }
  }
}
```

This is intentional. The returned `args` can be passed after the `orchestrator`
binary from any current directory.

The downside is visible in compact JSON: every command repeats
`--workspace <absolute-path>`, and sometimes `--orchestrator-dir <absolute-path>`
or `--config <absolute-path>`. With many tasks or long paths, the command
payload dominates the output.

## Code Findings

Portable args are appended in several places:

- `packages/cli/src/cli.ts`
  - `stopArgsSuffix(options)` appends `--workspace <path>` and optional
    `--orchestrator-dir <path>`.
  - `withPortableStopArgs(...)` appends that suffix across compact `ps`
    commands, group commands, task commands, and stop targets.
  - batch `read` and batch `launch` pass the same suffix into
    `taskBatchControlCommands(...)`.
  - `helpArgsSuffix(...)` and `compactPsViewCommands(...)` also emit portable
    follow-up args with workspace/config context.
- `packages/cli/src/task-json.ts`
  - `taskCommandSummary(...)` accepts `stopArgsSuffix` and passes it into
    task command/stop builders.
- `packages/core/src/tasks/operations.ts`
  - `taskControlCommands(...)`, `taskBatchControlCommands(...)`, and
    `groupControlCommands(...)` build the core command arrays.

Tests already protect portability:

- `CLI JSON stop args are portable across cwd and custom task stores`
- `CLI compact ps command args are portable across cwd`
- `CLI accepts common options before commands and portable args can override
them`

So removing the path from current `args` would be a regression.

## Options

### Option 1: Keep Current Behavior

No risk, but long paths stay noisy. This does not address the issue.

### Option 2: Drop `--workspace` From `args`

This makes output shorter, but breaks the existing contract. Agents may execute
returned args from a different cwd. Existing portability tests would have to be
weakened. This is the wrong default.

### Option 3: Add Display Strings Only

Add a human string such as:

```json
{ "display": "orchestrator read abc12345 --wait --json --compact" }
```

This helps humans, but not agents. Agents would still need to use the long
portable `args` array or parse a shell-like string. This is useful but
insufficient by itself.

### Option 4: Add Local Args Beside Portable Args

Keep current `args`, add:

```json
{
  "args": ["read", "abc12345", "--json", "--workspace", "/repo"],
  "localArgs": ["read", "abc12345", "--json"]
}
```

This preserves compatibility and gives agents a shorter array. The downside is
larger JSON because every command now has two arrays.

### Option 5: Add Explicit Local Command Mode

Keep the default portable `args`. Add an opt-in mode:

```sh
orchestrator ps --json --compact --brief --local-commands
```

In that mode returned args omit the workspace suffix and the payload declares
the cwd requirement once:

```json
{
  "commandContext": {
    "mode": "local",
    "cwd": "/repo"
  },
  "commands": {
    "waitPreview": {
      "args": ["read", "abc12345", "--wait", "--json", "--compact"]
    }
  }
}
```

This is the cleanest tradeoff. The default stays safe. Callers who control cwd
can ask for shorter commands.

## Finding

Do not change the default `args` contract. Add an explicit local command mode
for compact JSON responses that return follow-up commands.

The feature should be framed as command portability, not as a new task model.
It should reuse the same command builders and change only the suffix attached
to returned command arrays.
