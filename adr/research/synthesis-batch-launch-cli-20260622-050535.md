# Synthesis: Batch Launch CLI

Date: 2026-06-22

## Recommendation

Add batch launch as a file/stdin mode on the existing `launch` command:

```sh
orchestrator launch --file agents.json --json --compact --brief
orchestrator launch -f - --json --compact --brief
```

Do not add a separate `bulk` command. Do not add a separate task model. Batch
launch should create normal tasks.

## Why This Fits

The product problem is simple: agents can already manage many tasks once they
exist, but creating many tasks still requires many CLI calls.

The code already has the right reusable pieces:

- launch plan builders;
- task supervision;
- task records;
- compact per-task commands;
- compact batch read/wait commands;
- scoped stop commands.

Batch launch should glue those existing pieces together.

## Why `launch --file`

Kubernetes uses file-based workflows for multiple resources, usually with
`apply -f` or `create -f`.

Orchestrator should not use `apply` yet because we are not reconciling desired
state. We are starting work.

`launch --file` keeps the current verb and adds the missing multi-item input.
It is familiar enough for Kubernetes users because of `-f`, but it remains true
to Orchestrator's actual behavior.

## What The First Slice Should Do

The first slice should support:

- JSON manifest file;
- stdin manifest with `-f -`;
- top-level `defaults`;
- per-task overrides;
- all-or-none preflight validation before any task starts;
- compact JSON response with:
  - summary;
  - launched tasks;
  - top-level batch read/wait commands;
  - top-level stop command;
  - per-task stop commands unless `--brief`.

The first slice should not support YAML, JSONL, declarative reconciliation,
batch resume/restart, or a new parent/group model.

## Important Design Constraint

This should reduce calls without hiding control.

An agent should be able to:

1. submit one manifest;
2. receive all task ids;
3. run one returned wait command;
4. run one returned stop command if needed.

That is the efficient loop.

## Code Direction

Refactor the current single launch path enough to avoid duplication:

- one helper builds `LaunchTaskInput` from normalized launch request fields;
- single launch passes one request;
- batch launch passes many requests;
- both use the same task launch helper;
- both use the same compact task summary helpers.

Do not over-abstract into a general workflow engine. This is just "start these
tasks."
