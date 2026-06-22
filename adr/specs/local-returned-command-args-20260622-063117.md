# Local Returned Command Args

Date: 2026-06-22

## Status

Draft spec.

## Intent

Reduce noisy returned command arrays when workspace paths are long, without
breaking the existing portable command contract.

The default must remain portable. Agents should still be able to run returned
`commands.*.args` and `stop.args` from any cwd. Local command mode is an opt-in
shorter form for callers that can run follow-up commands from the workspace cwd.

## CLI Shape

Add:

```sh
--local-commands
```

Use it with compact JSON commands that return follow-up args:

```sh
orchestrator launch codex --json --compact --local-commands "Inspect the repo."
orchestrator launch -f agents.json --json --compact --brief --local-commands
orchestrator ps --json --compact --active --brief --local-commands
orchestrator read <id> <id> --wait --json --compact --local-commands
orchestrator logs <id> --json --compact --local-commands
orchestrator events <id> --json --compact --local-commands
```

Rules:

- `--local-commands` requires `--json --compact`.
- Default behavior is unchanged.
- Local command mode only changes returned command arrays. It does not change
  which task store is read by the current command.
- Local command mode means returned args are intended to be run from the
  workspace cwd.

## JSON Shape

Default portable output remains:

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

With `--local-commands`:

```json
{
  "commandContext": {
    "mode": "local",
    "cwd": "/very/long/workspace/path"
  },
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
        "--compact"
      ]
    }
  }
}
```

For non-default task stores, keep the store context in returned args:

```json
{
  "commandContext": {
    "mode": "local",
    "cwd": "/repo"
  },
  "commands": {
    "waitPreview": {
      "args": [
        "read",
        "abc12345",
        "--wait",
        "--json",
        "--compact",
        "--orchestrator-dir",
        "/custom/store"
      ]
    }
  }
}
```

Do not hide `--orchestrator-dir` unless the implementation can safely express it
relative to `commandContext.cwd`.

## Command Context

Add a small context object to compact JSON outputs that include returned args:

```ts
type CommandContext = {
  mode: "local";
  cwd: string;
};
```

Recommendation:

- Include `commandContext` only when `--local-commands` is used.
- Do not add it to default portable output in the first slice, to avoid making
  current compact JSON larger.

## Implementation Shape

Add a command-args context in the CLI layer:

```ts
type ReturnedCommandArgsMode = "portable" | "local";

type ReturnedCommandArgsContext = {
  mode: ReturnedCommandArgsMode;
  workspaceRoot: string;
  orchestratorDir?: string;
  configPath?: string;
};
```

Replace direct calls to `stopArgsSuffix(options)` and similar ad hoc helpers
with one helper that returns the suffix for returned command arrays:

```ts
function returnedCommandArgsSuffix(options, behavior: { includeConfig?: boolean } = {}): string[] {
  if (options.localCommands) {
    return [
      ...(options.orchestratorDir ? ["--orchestrator-dir", options.orchestratorDir] : []),
      ...(behavior.includeConfig && options.configPath ? ["--config", options.configPath] : []),
    ];
  }

  return [
    "--workspace",
    options.workspaceRoot,
    ...(options.orchestratorDir ? ["--orchestrator-dir", options.orchestratorDir] : []),
    ...(behavior.includeConfig && options.configPath ? ["--config", options.configPath] : []),
  ];
}
```

For task-level commands, current `stopArgsSuffix(...)` does not include
`--config`; keep that behavior unless the specific command family already needs
config. Do not make follow-up task commands depend on runtime config when they
only need the task store.

Add a payload helper:

```ts
function commandContextJson(options): { commandContext?: CommandContext } {
  return options.localCommands
    ? { commandContext: { mode: "local", cwd: options.workspaceRoot } }
    : {};
}
```

Apply it to compact outputs that return command arrays:

- launch compact result;
- batch launch compact result;
- compact read result;
- batch compact read result;
- compact logs/events result;
- compact ps view and `views.*.args`.

## Parser Shape

Extend relevant option types with:

```ts
localCommands: boolean;
```

Parse `--local-commands` on commands that return compact command arrays. Reject
it when `--json --compact` is not present:

```text
--local-commands requires --json --compact.
```

Do not make this a global option until every command that could see it knows how
to validate it.

## Tests

Add tests for:

- default compact launch/read/ps output still includes portable `--workspace`;
- `--local-commands` compact launch omits `--workspace` from returned args and
  includes `commandContext.cwd`;
- local returned args work when executed with `cwd` set to `commandContext.cwd`;
- executing local returned args from another cwd is not supported and does not
  need compatibility guarantees;
- custom `--orchestrator-dir` remains present in local returned args;
- `--local-commands` without `--json --compact` fails clearly;
- batch launch top-level `commands.waitPreview.args` and `stop.args` respect
  local mode;
- compact `ps` top-level commands, group commands, task commands, and stop
  targets respect local mode.

Keep existing portability tests unchanged. They prove the default remains safe.

## Non-Goals

- Do not remove portable args.
- Do not replace args arrays with shell strings.
- Do not add a new command schema version.
- Do not add a new task model or task store behavior.
- Do not solve every path-length case for custom stores in the first slice.

## Expected Result

Default output remains safe:

```sh
orchestrator ps --json --compact --active --brief
```

Agent/human-local output becomes shorter:

```sh
orchestrator ps --json --compact --active --brief --local-commands
```

Callers that want maximum safety use default portable args. Callers that control
cwd use local args and read `commandContext.cwd` once instead of seeing the same
workspace path repeated in every returned command.
