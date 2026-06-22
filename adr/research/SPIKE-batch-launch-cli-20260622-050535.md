# SPIKE: Batch Launch CLI

Date: 2026-06-22

## Question

How should Orchestrator let agents launch many child agents in one CLI call
without making the code ugly or creating a second launch system?

## Current Behavior

Single launch is strong:

```sh
orchestrator launch codex --name "inspect api" --json --compact --brief "Inspect the API."
```

The result gives an id, task id, status, and scoped stop args.

Bulk management already exists after tasks are created:

```sh
orchestrator read <id> <id> --wait --json --compact
orchestrator interrupt <id> <id> --json --compact
orchestrator interrupt --active --json --compact
orchestrator interrupt --group <id> --json --compact
```

The gap is creation. Starting six agents still requires six separate `launch`
calls.

## Code Findings

The single-launch path in `packages/cli/src/cli.ts` does four things:

1. parse `launch` args into `LaunchOptions`;
2. load configured runtimes;
3. build an `AgentLaunchPlan`;
4. create a `LaunchTaskInput` and call `launchTask` or the detached
   `launchInBackground` helper.

The core task system is already reusable:

- `buildAgentLaunchPlan(...)` validates runtime/model/output-mode behavior;
- `launchTask(...)` owns task files, process supervision, logs, events, output,
  usage, timeout, and final status;
- `taskCommandSummary(...)` builds per-task compact follow-up commands;
- `taskBatchControlCommands(...)` already builds batch read/wait commands for a
  list of task ids;
- compact `ps` already returns a top-level batch `stop` target for several
  active tasks.

So batch launch should not create new task primitives. It should prepare many
normal `LaunchTaskInput` objects and call the same launch path for each.

## Existing Bulk Patterns

Bulk read and bulk interrupt establish the pattern:

- positional multiple ids are accepted where the action naturally targets a
  selected set;
- compact JSON returns a top-level summary;
- compact JSON returns top-level follow-up commands;
- per-task detail is kept small under `--brief`;
- broad destructive actions require explicit selectors like `--active` or
  `--group`.

Batch launch should follow the same contract: one summary, one task list, one
batch wait command, one scoped stop command.

## Naming

Kubernetes-style workflows usually create multiple resources from a file:

```sh
kubectl apply -f file.yaml
kubectl create -f file.yaml
```

For Orchestrator, `apply` would imply declarative reconciliation. We are not
reconciling desired state. We are starting jobs now.

The truest name is still `launch`, with a file flag:

```sh
orchestrator launch --file agents.json --json --compact --brief
orchestrator launch -f - --json --compact --brief
```

Call the feature "batch launch" in docs, but keep the CLI under the existing
`launch` verb.

## Input Shape

Use JSON, not YAML, for the first slice. The repo already uses JSON for custom
agent config, and agents can produce JSON reliably.

Recommended manifest:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "runtime": "codex",
    "model": "gpt-5.4-mini"
  },
  "tasks": [
    {
      "name": "inspect cli",
      "task": "Inspect the CLI package."
    },
    {
      "runtime": "claude-code",
      "model": "haiku",
      "name": "review docs",
      "task": "Review the docs."
    }
  ]
}
```

Support stdin with `-` so agents do not need temporary files:

```sh
orchestrator launch -f - --json --compact --brief <<'JSON'
{
  "schemaVersion": 1,
  "tasks": [
    { "runtime": "codex", "name": "one", "task": "Do one." },
    { "runtime": "codex", "name": "two", "task": "Do two." }
  ]
}
JSON
```

## Validation

Preflight all items before launching any task.

That means:

- parse JSON;
- validate `schemaVersion`;
- validate `tasks` is a non-empty array;
- merge CLI defaults, manifest defaults, and per-task fields;
- build every launch plan;
- only then start tasks.

This avoids the worst agent UX: half the batch starts, then item 4 fails because
of a typo.

Runtime failures after launch are normal task failures. They should become task
records, just like single launch.

## Implementation Implications

The clean patch is mostly CLI-level:

- extend launch parsing with `--file <path|->` / `-f <path|->`;
- add a small manifest parser module;
- extract the single-task launch preparation into a reusable helper;
- have single launch and batch launch call that helper;
- build batch compact JSON using existing `taskCommandSummary` and
  `taskBatchControlCommands`.

Do not add a new supervisor, task model, or durable group table.

## Open Questions

- Should batch `--wait` be supported immediately?
  - Recommendation: not in the first slice. Return `commands.waitPreview.args`
    instead. That keeps launch fast and uses the existing batch read command.
- Should JSONL manifests be supported?
  - Recommendation: not in the first slice. JSON object with `defaults` and
    `tasks` is clearer.
- Should per-task shell policy live in the manifest?
  - Recommendation: no for now. Treat `shell` as a normal runtime choice in the
    manifest, not as a separate manifest-level policy.
