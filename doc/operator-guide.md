# Operator Guide

The README explains how to use Orchestrator as a skill. This guide explains the
control plane underneath it: what runs, where state lives, how to inspect work,
and which operational boundaries matter.

## Contents

- [Mental model](#mental-model)
- [Install and scope](#install-and-preflight)
- [Task lifecycle and files](#task-lifecycle)
- [One task and many tasks](#one-task)
- [Views, output, and JSON control](#views-and-observation)
- [Interrupt and parent orchestration](#interrupt-and-cleanup)
- [Runtimes, resume, and sessions](#runtimes)
- [Model discovery](#model-discovery)
- [Limits and configuration](#limits-and-preferences)
- [App integration and diagnostics](#app-integration)

## Mental Model

Orchestrator separates judgment from execution:

```text
user
  -> calling agent
     -> Orchestrator skill
        -> orchestrator CLI
           -> detached task supervisor
              -> Claude Code, Codex, Copilot, Grok, Pi, shell, or custom process
           -> ~/.orchestrator task store
```

The calling agent decides what to delegate, which runtime and model to use, and
how to synthesize results. The skill teaches that agent the workflow and loads
optional user preferences. The CLI builds launch plans, starts processes,
captures output, normalizes events, stores task state, and stops work.

Orchestrator is local and task-shaped. It is not a distributed scheduler, a
provider proxy, or an automatic model router.

## Install And Preflight

Install the skill and CLI:

```sh
npx skills add backnotprop/orchestrator
npm install -g @backnotprop/orchestrator-cli
```

From this repository:

```sh
pnpm install
pnpm orchestrator --help
```

Before operating an unfamiliar machine or workspace:

```sh
orchestrator help --json --compact
orchestrator doctor --json --compact
orchestrator models --json --compact
orchestrator limits --json --compact
```

- `help --json --compact` is the current machine-facing command contract.
- `doctor` checks runtime executables and parent-agent configuration.
- `runtimeSummary.availableIds` lists launchable runtime ids.
- `models` reads current provider catalogs, aliases, routers, and defaults.
- `limits` reads supported provider limit snapshots. It does not route or
  block work.

## Scope: Store, Workspace, And CWD

Orchestrator uses one machine-level store by default:

```text
~/.orchestrator/tasks/
```

Three paths have different jobs:

- **Store**: where task records, output, and control state live.
- **Workspace**: project scope for listing, grouping, config discovery, and
  default launch location.
- **CWD**: the directory where the provider process runs.

Use `--workspace <path>` to operate on another project. Use `--cwd <path>`
when a task should run below or outside the workspace default. Use
`--orchestrator-dir <path>` only when a separate task store is intentional.

Common options such as `--workspace`, `--orchestrator-dir`, `--config`,
and `--json` may appear before or after the command.

## Task Lifecycle

A normal launch returns immediately with a task id:

```sh
orchestrator launch codex \
  --name "inspect store" \
  --json --compact --brief \
  "Inspect the task store."
```

The CLI writes a run request and starts a detached supervisor. The supervisor:

1. creates task files;
2. records queued, starting, and running state;
3. starts the provider process in its own process group;
4. captures stdout and stderr;
5. normalizes provider events and usage when supported;
6. writes the final result and terminal state;
7. responds to interrupt and timeout control.

Task state can finish as `succeeded`, `failed`, `cancelled`, or
`timed_out`. If supervision evidence disappears while a task still claims to
be active, Orchestrator exposes it as unavailable or lost rather than signaling
an unverified process id.

The detailed parent/child call path is documented in
[How the Parent Agent Runs and Waits](internal/run.md). The process relationship
is also shown in
[the supervision model](internal/supervision-model.svg).

## Task Files

Each task has a directory:

```text
~/.orchestrator/tasks/<task-id>/
  task.json
  stdout.log
  stderr.log
  combined.log
  events.jsonl
  transcript.jsonl
  result.md
  artifacts/
```

- `task.json` is the durable task record.
- `stdout.log` and `stderr.log` are raw process output.
- `combined.log` preserves captured stdout and stderr order.
- `events.jsonl` is the Orchestrator task and normalized agent timeline.
- `transcript.jsonl` keeps structured provider output when available.
- `result.md` is the readable final answer.
- `artifacts/` is reserved for task artifacts.

Process-supervised tasks also use `heartbeat.json` as liveness evidence.

Use CLI commands instead of reading these files directly in normal operation.
The files are useful for diagnostics and app integration.

## One Task

```sh
orchestrator launch claude-code \
  --name "review tests" \
  "Review this repo and find the highest-risk missing tests."
```

Use the returned full id or an unambiguous prefix:

```sh
orchestrator watch <task-id>
orchestrator read <task-id> --wait
orchestrator logs <task-id> --follow
orchestrator events <task-id> --agent-only
```

Use `--name` consistently. Names make `list` and `ps` useful when many
tasks are active.

## Many Tasks

Use a manifest to preflight and launch several independent jobs in one call:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "runtime": "codex"
  },
  "tasks": [
    {
      "name": "inspect store",
      "task": "Inspect the task store."
    },
    {
      "runtime": "claude-code",
      "name": "review tests",
      "task": "Find missing tests."
    },
    {
      "runtime": "grok",
      "name": "review api",
      "task": "Inspect the API boundary."
    }
  ]
}
```

```sh
orchestrator launch -f agents.json --json --compact --brief
orchestrator ps --json --compact --active --brief
orchestrator read <id> <id> <id> --wait --json --compact
```

Manifest launch preflights every task before starting any target. Keep
independent jobs separate so one task has one owner, one status, and one result.

## Views And Observation

```sh
orchestrator list
orchestrator ps
orchestrator ps --watch
orchestrator ps -A
orchestrator ps --all
orchestrator ps -A --all
```

- `list` is a flat task list.
- `ps` groups parent runs and child tasks in the current workspace.
- `ps -A` scans every workspace in the machine store.
- `--active` limits output to active work.
- `--all` includes old finished work hidden by the normal recent view.
- `--watch` refreshes the human operations view.
- `--brief` reduces compact JSON payload size.

Use `ps --parent <run-id|prefix>` to stay scoped to one parent operation.

## Read, Watch, Logs, And Events

These surfaces answer different questions:

| Command  | Use                                                    |
| -------- | ------------------------------------------------------ |
| `read`   | Get final output, status, usage, and errors            |
| `watch`  | Follow one task's event stream live                    |
| `logs`   | Inspect raw stdout and stderr                          |
| `events` | Inspect the durable task and normalized agent timeline |

```sh
orchestrator read <id> --wait --json --compact
orchestrator watch <id> --agent-only --json
orchestrator logs <id> --follow --stream all
orchestrator events <id> --agent-only --json --compact
```

`read --wait` is preferred when the next operation needs the result. A timed
out wait reports that the task is still active; it does not claim completion.

Structured output can be limited twice:

- a read limit can be increased by reading again with a larger bound;
- a capture limit was fixed at launch and cannot be recovered later.

Check `outputTruncated`, `stdoutTruncated`, and `stderrTruncated` in JSON
responses.

## JSON Control Contract

Agents and integrations should prefer JSON:

```sh
orchestrator launch codex --json --compact --brief "Inspect the registry."
orchestrator ps --json --compact --active --brief
orchestrator read <id> --wait --json --compact
```

Compact task summaries include portable control arrays such as:

- `commands.read.args`
- `commands.wait.args`
- `commands.watch.args`
- `commands.agentWatch.args`
- `commands.logsPreview.args`
- `commands.events.args`
- `stop.args`

Pass these values back to the `orchestrator` executable as argument arrays.
Do not join them into one shell string.

Compact group and `ps` responses may include `commands.waitPreview.args`
for the listed set. Lookup errors may include `recovery.views.*.args` for
missing or ambiguous ids. JSON command errors are written as machine-readable
objects; inspect `reason`, `input`, `matches`, and `hint`.

## Interrupt And Cleanup

Stop exact work whenever possible:

```sh
orchestrator interrupt <id> --json --compact --reason "no longer needed"
orchestrator interrupt <id> <id> --json --compact --reason "duplicate work"
```

Stop every active task in one workspace only when intentional:

```sh
orchestrator interrupt --active --json --compact --reason "workspace cleanup"
```

Machine-wide cleanup requires an explicit all-workspace selector and
confirmation:

```sh
orchestrator interrupt -A --active --yes --json --compact --reason "machine cleanup"
```

Prefer returned `stop.args`, which carries the scope represented by the JSON
view.

## Parent Agent

`orchestrator run` starts a Pi-backed parent agent with only Orchestrator
tools enabled:

```sh
orchestrator run "Launch independent reviewers, wait for them, then synthesize."
```

Use `--trace-tools` for a readable live tool trace or `--stream-json` for a
machine-readable parent event stream:

```sh
orchestrator run --trace-tools "Launch a Codex child and wait for it."
orchestrator run --stream-json "Launch a Codex child and wait for it."
```

Use a background parent when the orchestration itself should be managed:

```sh
orchestrator run --background \
  --name "repo review" \
  --json --compact \
  "Launch independent reviewers, wait for them, then synthesize."
```

The background parent becomes a normal task with runtime `orchestrator`.
Children store parent metadata, and `ps` groups them below the parent.

Parent auth, models, sessions, and doctor behavior are covered in
[Parent Agent Config](parent-agent-config.md).

## Runtimes

Built-in launch targets:

| Runtime            | Shape    | Resume | Notes                                 |
| ------------------ | -------- | ------ | ------------------------------------- |
| `claude-code`      | Process  | Yes    | Structured headless Claude Code       |
| `codex`            | Process  | Yes    | Stable one-shot `codex exec` path     |
| `codex-app-server` | Protocol | Yes    | One-shot or persistent Codex sessions |
| `copilot`          | Process  | Yes    | Copilot CLI programmatic mode         |
| `grok`             | Process  | Yes    | Grok Build streaming JSON mode        |
| `pi`               | Process  | No     | Pi print-mode process                 |
| `shell`            | Process  | No     | Exact local shell commands            |

Runtime config decides the executable, prompt transport, output adapter, model
flag, timeout, capture limit, and control capabilities. `--model` is passed
through using that runtime's configured model flag.

Keep each runtime's default structured output mode when reliable final results,
provider ids, usage, or resume matter. Plain text and provider-specific JSON
modes are primarily diagnostic unless their adapter preserves the same
metadata.

Built-ins can be disabled. Custom process runtimes can be added without core
code changes. See [Custom Agents](custom-agents.md) and
[Disable Agents](disable-agents.md).

## Model Discovery

Do not keep a model registry in docs or infer "latest" by sorting model names.
Ask the configured runtime:

```sh
orchestrator models <runtime> --json --compact
orchestrator models --json
```

The compact response contains launchable `models[].id` values, nonredundant
display names, each value's kind, the runtime default when known, discovery
status, source, and CLI version. Use `fullModels.args` when descriptions, input
modalities, or reasoning options are needed.

| Runtime            | Discovery source                 |
| ------------------ | -------------------------------- |
| `codex`            | App-server `model/list` protocol |
| `codex-app-server` | App-server `model/list` protocol |
| `claude-code`      | Latest-family aliases from help  |
| `copilot`          | Current CLI catalog plus `auto`  |
| `grok`             | Authenticated `grok models`      |
| `pi`               | Authenticated `pi --list-models` |

Claude Code reports `partial` because it exposes stable current-family aliases
instead of an exact catalog. Unsupported custom runtimes report `unsupported`
without blocking peer discovery.

Selection rules are intentionally small:

- omit `--model` when no override is required;
- validate an exact requested id against live output;
- use a returned default, alias, or router for "latest" or "best";
- never silently substitute an exact requested id unless preferences allow a
  fallback.

## Resume

`resume` creates a new Orchestrator task linked to a completed source task
while continuing the provider session:

```sh
orchestrator resume <task-id> --json --compact "Continue from the prior result."
```

Resume requires:

- a terminal source task;
- runtime resume support;
- stored provider metadata from a reliable structured output mode;
- no other active task using the same provider session.

Each resumed task has its own logs, events, result, and status. Orchestrator
also verifies the provider did not silently return a different session id.

## Persistent Codex Sessions And Goals

Use `codex` for one-shot work. Use `codex-app-server --session` when work
needs repeated messages, steering, provider-thread continuity, or native goals:

```sh
orchestrator launch codex-app-server --session \
  --name "performance worker" \
  --json --compact --brief

orchestrator send <id> --wait --json --compact "Inspect the bottlenecks."
orchestrator goal start <id> --wait --json --compact "Improve performance."
orchestrator goal get <id> --json --compact
orchestrator goal set <id> --status paused --json --compact
orchestrator goal clear <id> --json --compact
```

Do not set a goal token budget unless a hard cap is intentional. A completed
turn returns the session to idle. Interrupting one session task does not stop
the shared backend or unrelated sessions.

See [Codex App Server Runtime](codex-app-server.md) for the protocol and session
details.

## Limits And Preferences

`orchestrator limits` reports factual provider/account snapshots for
supported providers:

```sh
orchestrator limits --json --compact
orchestrator limits --provider codex --json --compact
orchestrator limits --provider copilot --json --compact
orchestrator limits --provider claude --json --compact
```

Snapshots may be available, partial, or unavailable. They do not choose a
runtime, spend budget, or enforce fallbacks.

Routing preferences live in
[`skills/orchestrator/PREFERENCES.md`](../skills/orchestrator/PREFERENCES.md).
The calling agent reads those instructions and combines them with live facts.
The current user request wins. Unknown limit data stays unknown.

## Configuration

The default runtime config file is:

```text
~/.orchestrator/config.json
```

Runtime config is merged in this order:

1. `$XDG_CONFIG_HOME/orchestrator/config.json`, or
   `~/.config/orchestrator/config.json`;
2. `~/.orchestrator/config.json`;
3. `<workspace>/orchestrator.config.json`;
4. `<workspace>/.orchestrator/config.json`;
5. explicit `--config <path>`.

Later files override earlier agent entries. This config controls built-in and
custom launch runtimes.

Parent-agent credentials and models are separate:

```text
~/.orchestrator/auth.json
~/.orchestrator/models.json
~/.orchestrator/sessions/
```

Do not put provider secrets in runtime errors, logs, preferences, or committed
config.

## App Integration

The packages can be embedded without using the standalone CLI:

```sh
npm install @backnotprop/orchestrator-core
npm install @backnotprop/orchestrator-agent
```

- `@backnotprop/orchestrator-core` provides runtime config, model discovery,
  launch plans, task storage, supervision, observation, and control.
- `@backnotprop/orchestrator-agent` provides the Pi-backed parent agent and
  Orchestrator tools.
- `@backnotprop/orchestrator-cli` provides the command-line surface.

```ts
import { buildAgentLaunchPlan, launchTask } from "@backnotprop/orchestrator-core";
```

Keep terminal rendering and argv parsing in the CLI package. Runtime and task
behavior belongs in core.

## Diagnostics

Start with:

```sh
orchestrator doctor --json
orchestrator ps -A --json --compact --active --brief
```

Then use the task-specific surfaces:

```sh
orchestrator read <id> --json --compact
orchestrator logs <id> --json --compact
orchestrator events <id> --json --compact
```

Common interpretations:

- **Runtime missing**: use `doctor`; install the provider CLI or choose an
  available runtime.
- **Task still active**: use `read --wait`, `watch`, or the returned wait
  command.
- **Task failed**: inspect compact logs and events before retrying.
- **Lost/unavailable task**: supervision evidence is stale or missing; do not
  signal a recorded pid manually.
- **Truncated output**: distinguish read-limit truncation from capture-limit
  truncation.
- **Resume rejected**: confirm the source is terminal, has provider metadata,
  and has no active task on the same provider session.
- **Ambiguous id**: use the matches or recovery view returned in the JSON error.

## Development

Use Node `>=24` and pnpm `10.18.0`:

```sh
pnpm install
pnpm check
```

Provider smoke tests are opt-in because they use local credentials and real
provider CLIs. Maintainer call paths live in [`doc/internal/`](internal/).
Architecture decisions live in [`adr/`](../adr/README.md).
