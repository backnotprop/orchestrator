# 29. Add batch launch manifests

Date: 2026-06-22

## Status

Accepted

## Context

Orchestrator can already manage many tasks after they exist. Agents can read
multiple tasks, interrupt multiple tasks, watch active work, and use compact
JSON responses to recover the next command to run.

The remaining gap is task creation. Starting several child agents still requires
several separate `orchestrator launch` calls. That is inefficient for agents and
awkward for humans when the intended action is clearly "start these jobs."

The current launch path already has reusable pieces: runtime validation, launch
plan building, task supervision, task records, compact task summaries, batch
read commands, and scoped stop commands. Batch launch should reuse those pieces
instead of creating a second task system.

## Decision

Add batch launch as a file/stdin mode on the existing `launch` command:

```sh
orchestrator launch --file agents.json --json --compact --brief
orchestrator launch -f agents.json --json --compact --brief
orchestrator launch -f - --json --compact --brief
```

The input will be a JSON manifest with `schemaVersion`, optional `defaults`, and
a `tasks` array. Per-task fields override manifest defaults. CLI defaults still
provide outer context such as workspace, config, model, timeout, and output
limits.

Batch launch will preflight the whole manifest before starting any task. If the
manifest is invalid, no task files are created. If a runtime fails after launch,
that is handled as a normal task failure.

Batch launch will create normal task records. It will not introduce a new task
model, a durable batch object, or a separate supervisor.

The first implementation will require `--json` for batch mode and will return a
compact response with launched task summaries, a batch read command, a batch
wait command, and a scoped stop command.

## Consequences

Agents can launch several child agents with one command and then follow returned
commands instead of guessing IDs or building command strings themselves.

The CLI stays close to existing behavior: single launch remains unchanged, and
batch launch is only another input path into the same task system.

The first slice will not support YAML, JSONL manifests, declarative `apply`,
batch restart/resume, or batch `--wait`. Waiting should use the returned
`commands.waitPreview.args` command.

Implementation should extract shared launch preparation helpers so single and
batch launch stay consistent without turning the CLI into a workflow engine.
