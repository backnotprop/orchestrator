# Orchestrator

Manage background agents. Coding agents, general agents, any agent.

_As agents become more capable, it becomes more useful to start them, leave them running, and manage_  
_their work in one place. Orchestration of agents is moving to the front. Babysitting them is on the_  
_way out._

It is agent-CLI first, and can be used as a skill:

```bash
/orchestrator Launch a GPT 5.5 agent to implement the ADR
```

The shape is intentionally close to tools like `kubectl`.

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

```sh
orchestrator watch <task-id>
orchestrator read <task-id>
orchestrator logs <task-id> --follow
orchestrator events <task-id>
orchestrator interrupt <task-id>
```

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

Use `@backnotprop/orchestrator-core` when you want the task store, runtime registry, launch plans,
and supervisor inside your own app instead of the standalone CLI.

```ts
import { buildAgentLaunchPlan, launchTask } from "@backnotprop/orchestrator-core";
```

The CLI package is `@backnotprop/orchestrator-cli`. The reusable runtime package is
`@backnotprop/orchestrator-core`.

## Commands

- `launch`: start an agent in the background
- `list`: see known tasks
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
Architecture decisions live in [doc/adr](doc/adr/README.md).
