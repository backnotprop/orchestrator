# Orchestrator

Manage background agents. Coding agents, agent assistants, any agent. <br/>
_Orchestration of agents is moving to the front. Hand holding is on the way out._

Orchestrator enables you or your agents to run other agents. It is agent-CLI
first: the main interface is a small CLI that another agent can learn and call.
Humans can use the same CLI directly when they want to operate the system
themselves.

Skills, plugins, the CLI, and the future TUI all use the same task state.

## How To Use It

### From An Agent

The preferred path is through an agent skill or plugin. Ask your agent to
delegate work, and it can use Orchestrator to start, watch, read, or stop other
agents.

```bash
/orchestrator Launch a Codex agent to inspect the task store.
```

### Let Orchestrator Coordinate

Use `run` when you want Orchestrator itself to think, launch child agents, wait
on them, and report back.

```sh
orchestrator run "Figure out what needs to change in this repo."
```

Use `--background` when the parent run should be managed like any other task.

```sh
orchestrator run --background --name "repo plan" "Figure out what needs to change in this repo."
orchestrator ps --watch
orchestrator read <task-id>
```

### Coordinate Agents Yourself

Use `launch` when you want to be the operator and start agents directly.

```sh
orchestrator launch claude-code --name "review tests" --model sonnet "Find missing tests."
orchestrator launch codex --name "inspect store" --model gpt-5.4-mini "Inspect the task store."
orchestrator launch custom --name "check email" --model glm-5.2 "Clean my inbox."
```

```console
$ orchestrator list
review tests     running  claude-code  sonnet         2m ago  3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
inspect store    running  codex        gpt-5.4-mini   1m ago  a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
check email      running  custom       glm-5.2        30s ago  d09edec6-2f14-48fc-924c-ec9f26b61ca0
```

The shape is intentionally close to tools like `kubectl`.

```sh
orchestrator doctor
orchestrator run --trace-tools "Launch a Codex child and wait for it."
orchestrator run --stream-json "Launch a Codex child and wait for it."
orchestrator ps
orchestrator ps --all
orchestrator ps --watch
orchestrator watch <task-id>
orchestrator read <task-id>
orchestrator logs <task-id> --follow
orchestrator events <task-id>
orchestrator interrupt <task-id>
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
- `run`: start the parent AI agent; add `--background` to manage it like a task, `--trace-tools` to see tool calls live, or `--stream-json` for a full JSONL stream
- `launch`: start an agent in the background
- `list`: see known tasks
- `ps`: see grouped agent work across parent runs
- `ps --all`: include old finished tasks hidden by the default view
- `watch`: follow one task live
- `read`: print the final answer
- `logs`: show raw agent output
- `events`: show what happened to the task
- `interrupt`: stop a running task

## Runtimes

First-class targets:

- Claude Code
- Codex

The runtime layer is generic, but the first release is focused on those two.
Built-in runtimes can also be disabled in config. See
[doc/disable-agents.md](doc/disable-agents.md).

## Files

Task state is stored under:

```text
.orchestrator/tasks/<task-id>/
```

Each task keeps its record, stdout/stderr logs, events, transcript, and final result.

## Example CLI Use

Kick off a few agents. Let them run. Check in when you need to.

### Start Claude

```console
$ orchestrator launch claude-code --name "review tests" --model sonnet "Review this repo and find the highest-risk missing tests."
taskId: 3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
name: review tests
status: running
runtime: claude-code
taskDir: /Users/me/project/.orchestrator/tasks/3f8d1f30-6c52-49dc-a7f7-3c3e04a98657
```

### Start Codex

```console
$ orchestrator launch codex --name "inspect store" --model gpt-5.4-mini "Inspect the task store and suggest cleanup opportunities."
taskId: a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
name: inspect store
status: running
runtime: codex
taskDir: /Users/me/project/.orchestrator/tasks/a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
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
updated 2026-06-18T22:50:54.458Z

MANUAL  2 agents  2 running
  name                   status     runtime      model            dur     tokens    started       last                         id
  review tests           running    claude-code  sonnet           12s     -         22:50:42      agent.reasoning              3f8d1f30
  inspect store          running    codex        gpt-5.4-mini     8s      16.5k     22:50:46      agent.message                a6d00f1d
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
taskDir: /Users/me/project/.orchestrator/tasks/a6d00f1d-25b4-4dd3-ae22-d12a381b80d4
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
taskDir: /Users/me/oss/api/.orchestrator/tasks/17a3b031-b1c2-4aa8-b70e-6cfeeaaf0b88
```

## Development

```sh
pnpm check
```

Custom agent configuration is described in [doc/custom-agents.md](doc/custom-agents.md).
The live agent view idea is tracked in [doc/live-agent-view.md](doc/live-agent-view.md).
Architecture decisions live in [doc/adr](doc/adr/README.md).
