# Orchestrator

Manage background agents. Coding agents, agent assistants, any agent. <br/>
_Orchestration of agents is moving to the front. Hand holding is on the way out._

Orchestrator lets you and your agents launch, watch, read, and stop other
agents.

It is agent-CLI first. Agents call it through a skill or plugin. Humans can use
the same CLI directly. The CLI now and the future TUI share the same task state.

By default, tasks live in one machine-level store at `~/.orchestrator/tasks`.
`workspace` is the project scope. `cwd` is where the agent process runs.

## How To Use It

### From An Agent

The preferred path is through an agent skill or plugin. Ask your agent to
delegate work.

```bash
/orchestrator Launch a Codex agent to inspect the task store.
```

### Let Orchestrator Coordinate

Use `run` when Orchestrator should coordinate other agents for you.

```sh
orchestrator run "Launch a Claude Code agent to do x, launch a Codex agent to do y"
```

Use `--background` when Orchestrator should keep running as a managed task.

```sh
orchestrator run --background --name "repo work" --json --compact "Launch a Claude Code agent to do x, launch a Codex agent to do y"
orchestrator ps --watch
orchestrator read <task-id|prefix>... --wait --json --compact
```

### Coordinate Agents Yourself

Use `launch` when you want to start agents directly.

```sh
orchestrator launch claude-code --name "review tests" --model sonnet "Find missing tests."
orchestrator launch codex --name "inspect store" --model gpt-5.4-mini "Inspect the task store."
orchestrator launch custom --name "check email" --model glm-5.2 "Clean my inbox."
```

Start several agents from one manifest:

```sh
orchestrator launch -f agents.json --json --compact --brief
```

```json
{
  "schemaVersion": 1,
  "defaults": {
    "runtime": "codex",
    "model": "gpt-5.4-mini"
  },
  "tasks": [
    {
      "name": "inspect store",
      "task": "Inspect the task store."
    },
    {
      "runtime": "claude-code",
      "model": "sonnet",
      "name": "review tests",
      "task": "Find missing tests."
    }
  ]
}
```

```console
$ orchestrator list
review tests     running  claude-code  sonnet         2m ago  3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
inspect store    running  codex        gpt-5.4-mini   1m ago  a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
check email      running  custom       glm-5.2        30s ago  d09edec6-2f14-48fc-924c-ec9f26b61ca0
```

Task commands accept the full task ID or a unique prefix shown by `ps` and
`list`.

The CLI shape is intentionally close to tools like `kubectl`.

```sh
orchestrator doctor
orchestrator run --trace-tools "Launch a Codex child and wait for it."
orchestrator run --stream-json "Launch a Codex child and wait for it."
orchestrator ps
orchestrator ps -A
orchestrator ps --all
orchestrator ps -A --all
orchestrator ps --watch
orchestrator ps --json --compact --active --brief
orchestrator ps -A --json --compact --active --brief
orchestrator launch codex --name "inspect store" --model gpt-5.4-mini --json --compact --brief "Inspect the task store."
orchestrator launch -f agents.json --json --compact --brief
orchestrator resume <task-id|prefix> --json --compact "Continue from the prior result."
orchestrator watch <task-id|prefix>
orchestrator read <task-id|prefix>... --wait --json --compact
orchestrator logs <task-id|prefix> --follow
orchestrator events <task-id|prefix> --json --compact
orchestrator interrupt <task-id|prefix> <task-id|prefix> --json --compact
orchestrator interrupt <task-id|prefix>
```

Configure the parent agent in `~/.orchestrator/auth.json`.
[Parent Agent Config](doc/parent-agent-config.md)

### Custom Agents

Custom agents can be registered in `~/.orchestrator/config.json`.

[Custom Agents](doc/custom-agents.md) · [Flue example](doc/custom-agents.md#flue-example)

## Install

### Skill

```bash
npx skills add backnotprop/orchestrator
```

<details>
<summary>Install Claude or Codex plugins</summary>

Codex:

```sh
codex plugin marketplace add backnotprop/orchestrator
codex plugin add orchestrator@orchestrator
```

Claude Code:

```text
/plugin marketplace add backnotprop/orchestrator
/plugin install orchestrator@orchestrator
```

</details>

### CLI

Install the CLI:

```sh
npm install -g @backnotprop/orchestrator-cli
```

```sh
orchestrator --help
```

Optional alias:

```sh
alias o=orchestrator
```

<details>
<summary>Persist the alias</summary>

For zsh:

```sh
echo 'alias o=orchestrator' >> ~/.zshrc
```

For bash:

```sh
echo 'alias o=orchestrator' >> ~/.bashrc
```

</details>

<details>
<summary>Install from this repo</summary>

```sh
pnpm install
```

```sh
pnpm orchestrator --help
```

</details>

### App Integration

```sh
npm install @backnotprop/orchestrator-core
```

```sh
npm install @backnotprop/orchestrator-agent
```

Use `@backnotprop/orchestrator-core` when you want the task store, runtime registry, launch plans,
and supervisor inside your own app instead of the standalone CLI.
Use `@backnotprop/orchestrator-agent` when you want the Pi-backed parent AI agent and its
Orchestrator tools.

```ts
import { buildAgentLaunchPlan, launchTask } from "@backnotprop/orchestrator-core";
```

The CLI package is `@backnotprop/orchestrator-cli`. The reusable runtime package is
`@backnotprop/orchestrator-core`. The parent AI agent package is
`@backnotprop/orchestrator-agent`.

## Commands

- `doctor`: check parent-agent auth, model, and session paths
- `doctor --json --compact`: check configured runtime availability; use `runtimeSummary.availableIds` when software needs launchable runtime ids
- If compact doctor returns `parent.canRun: true`, append the request to `parent.run.argsPrefix` or `parent.run.backgroundArgsPrefix`
- `help --json --compact`: get the small command contract for agents/scripts; use `help --json` when you need the full contract
- `run`: start the parent AI agent; add `--background` to manage it like a task, `--trace-tools` to see tool calls live, or `--stream-json` for a full JSONL stream
- `launch`: start one agent in the background; add `--json --compact` for a small machine-readable result, or use `launch -f agents.json --json --compact --brief` to start several agents from one manifest
- `resume`: start a new task that resumes a finished Codex or Claude Code provider session
  Resume needs stored provider metadata, so use the default structured runtime
  modes when you may want to resume later.
- `list`: see known tasks in a simple task list
- `ps`: see grouped agent work in the current workspace
- `ps -A`: see grouped agent work across all workspaces
- `ps --all`: include old finished tasks hidden by the default view in the current workspace
- `ps -A --all`: include old finished tasks across all workspaces
- Common options like `--workspace`, `--orchestrator-dir`, `--config`, and `--json` may appear before or after the command
- `ps --json --compact --active`: get active tasks and stop targets for agents/scripts
- `ps --json --compact --active --brief`: scan many active tasks with less JSON
- `ps -A --json --compact --active --brief`: scan active tasks across all workspaces
- `ps --parent <run-id|prefix> --json --compact --brief`: inspect one parent run and its children
- If active compact `ps` is empty after short work, run `views.recent.args` from the compact response to recover recent finished tasks and batch read commands
- After starting several tasks, use `ps --json --compact --brief` and top-level `commands.waitPreview.args` to collect the listed set
- JSON task summaries include portable `commands.*.args`; run `orchestrator` with those args to read, watch, log, or inspect events
- JSON lookup errors can include `recovery.views.*.args`; run those args to recover from missing or ambiguous task/group ids
- Compact `ps` output can include top-level `commands.*.args` for every listed task; use `commands.waitPreview.args` to wait for the listed set with bounded output
- Compact `ps` group entries can include their own `commands.waitPreview.args`; use those when software should wait for one parent/group instead of the whole view
- Use task-level `commands.read.args` for an immediate JSON read and `commands.wait.args` when software should wait for one final result
- Use `read <id> <id> --wait --json --compact` when software needs to build its own multi-task wait call
- If compact `read` returns `active: true`, use `commands.waitPreview.args` to wait with bounded output or `commands.readPreview.args` to poll again
- If compact batch `read` times out, use top-level `commands.waitPreview.args` to wait again or `stop.args` to stop still-active work safely
- If compact `read` returns failed status, use `commands.logsPreview.args` for bounded raw logs or `commands.events.args` for the task timeline
- Use `logs --json --compact` for a one-line raw stdout/stderr snapshot and `events --json --compact` for a one-line task timeline
- If compact `read` is truncated by read limit, use `commands.read.args` to fetch more output
- Use `commands.watch.args` for the full live stream and `commands.agentWatch.args` for normalized live agent events only
- JSON stop targets include portable `stop.args`; run those args to stop exactly the returned task, group, or selected active set
- Compact `ps` `stop.args` is scoped to the current view; parent/group stops may include children of that selected run
- `ps --all --json --compact`: get compact full task history for the current workspace
- `ps -A --all --json --compact`: get compact full task history across all workspaces
- `watch`: follow one task live; add `--agent-only --json` for normalized agent event JSONL
- `read`: print the final answer; add `--json` for status, `exitCode`, output, usage, and errors
- `logs`: show raw agent output
- `events`: show what happened to the task
- `interrupt`: stop running tasks; pass multiple ids for a selected subset, add `--active --json` for workspace cleanup, or use `-A --active --yes --json` for deliberate all-workspace cleanup

## Runtimes

First-class targets:

- Claude Code
- Codex

`codex` is the stable headless Codex runtime backed by `codex exec`.
`codex-app-server` is the experimental protocol runtime backed by
`codex app-server --listen stdio://`.

The runtime layer is generic, but the first release is focused on Claude Code
and Codex. `shell` is also enabled as a local-command runtime for research,
tests, and operator utility tasks.
Built-in runtimes can also be disabled in config. See
[doc/disable-agents.md](doc/disable-agents.md).
For the app-server runtime distinction and current limits, see
[doc/codex-app-server.md](doc/codex-app-server.md).

## Files

Task state is stored under:

```text
~/.orchestrator/tasks/<task-id>/
```

Each task keeps its record, stdout/stderr logs, events, transcript, and final result.
Use `--orchestrator-dir <path>` only when you intentionally want a separate store.

## Example CLI Use

Kick off a few agents. Let them run. Check in when you need to.

### Start Claude

```console
$ orchestrator launch claude-code --name "review tests" --model sonnet "Review this repo and find the highest-risk missing tests."
taskId: 3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
name: review tests
status: running
runtime: claude-code
taskDir: /Users/me/.orchestrator/tasks/3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
```

### Start Codex

```console
$ orchestrator launch codex --name "inspect store" --model gpt-5.4-mini "Inspect the task store and suggest cleanup opportunities."
taskId: a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
name: inspect store
status: running
runtime: codex
taskDir: /Users/me/.orchestrator/tasks/a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
```

### See What Is Running

```console
$ orchestrator list
review tests	running	claude-code	sonnet	4s ago	3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
inspect store	running	codex	gpt-5.4-mini	1s ago	a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
```

### Watch The Whole Operation

```console
$ orchestrator ps --watch
updated 22:50:54  2 running  16k tok

manual launches  running  2 agents  2 running  16k tok
  agent        work                         status   model          started  dur   tok    last                     id
  claude-code  review tests                 running  sonnet         22:50:42 12s   -      agent.reasoning          3f8d1f30
  codex        inspect store                running  gpt-5.4-mini   22:50:46 8s    16k    agent.message            a6d00f1d
```

### Follow One Agent

```console
$ orchestrator watch 3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
2026-06-17T19:45:12.033Z	queued
2026-06-17T19:45:12.034Z	starting
2026-06-17T19:45:12.081Z	running	pid=41821
2026-06-17T19:45:16.913Z	runtime.init
2026-06-17T19:45:22.447Z	agent.reasoning	thinking
2026-06-17T19:46:04.119Z	result
2026-06-17T19:46:04.120Z	completed
```

### Read The Answer

```console
$ orchestrator read 3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
The highest-risk missing tests are around detached task supervision, interrupted agent cleanup, and output adapter edge cases.
```

### Check Logs

```console
$ orchestrator logs 3f8d1f30-6c52-49dc-a7f7-3c3e04a98657 --stream stdout --follow
{"type":"system","subtype":"init","session_id":"..."}
{"type":"assistant","message":{"content":[{"type":"text","text":"I'll inspect the tests and task supervision path."}]}}
...
{"type":"result","result":"The highest-risk missing tests are around detached task supervision..."}
```

### Check Events

```console
$ orchestrator events 3f8d1f30-6c52-49dc-a7f7-3c3e04a98657 --agent-only --json
[
  {
    "seq": 4,
    "taskId": "3f8d1f30-6c52-49dc-a7f7-3c3e04a98657",
    "type": "agent_event",
    "data": {
      "runtime": "claude-code",
      "kind": "runtime.init",
      "sourceType": "system"
    }
  }
]
```

### Stop One

```console
$ orchestrator interrupt a6d00f1d-25b4-4dd3-ae22-d12a381b80d4 --reason "Claude already covered this"
taskId: a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
name: inspect store
status: cancelled
runtime: codex
taskDir: /Users/me/.orchestrator/tasks/a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
```

### Use JSON

```console
$ orchestrator launch codex --name "summarize registry" --model gpt-5.4-mini --json "Summarize the runtime registry."
{
  "taskId": "9be4d3ff-4956-4dd9-b75e-73616de7c0de",
  "name": "summarize registry",
  "runtime": "codex",
  "status": "running",
  "createdAt": "2026-06-17T19:49:21.104Z"
}
```

### Work In Another Repo

```console
$ orchestrator launch claude-code --workspace /Users/me/oss/api --name "migration bug" --model sonnet "Find the highest-risk migration bug."
taskId: 17a3b031-b1c2-4aa8-b70e-6cfeeaaf0b88
name: migration bug
status: running
runtime: claude-code
taskDir: /Users/me/.orchestrator/tasks/17a3b031-b1c2-4aa8-b70e-6cfeeaaf0b88
```

## Development

```sh
pnpm check
```

Custom agent configuration is described in [doc/custom-agents.md](doc/custom-agents.md).
The live agent view idea is tracked in [doc/live-agent-view.md](doc/live-agent-view.md).
Architecture decisions live in [adr](adr/README.md).
