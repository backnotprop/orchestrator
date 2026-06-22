# Synthesis: Returned command args

Date: 2026-06-22

## Recommendation

Keep `commands.*.args` and `stop.args` portable by default.

Add an opt-in local command mode for compact JSON outputs:

```sh
orchestrator ps --json --compact --brief --local-commands
orchestrator launch -f agents.json --json --compact --brief --local-commands
```

When local command mode is active, returned command arrays omit
`--workspace <absolute-path>` and include one payload-level context block:

```json
{
  "commandContext": {
    "mode": "local",
    "cwd": "/repo"
  }
}
```

That tells agents and humans: these args are shorter, but run them from this
workspace cwd.

## Why This Fits

Portable args are valuable. They let agents run returned commands without
remembering where the original command was executed. Existing tests protect that
behavior.

The problem is presentation and token cost, not correctness. Long absolute
paths repeated in every returned command make compact JSON harder to scan and
larger than it needs to be.

An explicit local mode gives the caller a clean choice:

- default mode: safest, portable from any cwd;
- local mode: shorter, valid when run from the workspace cwd.

## What Not To Do

Do not silently drop `--workspace` from current `args`.

Do not replace arrays with shell strings. Arrays are the right machine contract.

Do not add a separate command object model per command family. The suffix logic
should be centralized so launch, read, ps, logs, events, and interrupt targets
stay consistent.

## First Slice

The first slice should support local command mode for compact JSON command
payloads that already return follow-up args:

- `launch --json --compact`
- `launch -f --json --compact`
- `ps --json --compact`
- `read --json --compact`
- `logs --json --compact`
- `events --json --compact`

It should not change full JSON output unless the command already shares the
same compact renderer.

`args` should keep the same field name in both modes. The mode is declared by
`commandContext.mode`, not by changing callers to a new field.
