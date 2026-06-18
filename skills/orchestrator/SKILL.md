---
name: orchestrator
description: Use Orchestrator to launch, watch, read, log, and interrupt background agent tasks from any agent environment. Use when the user asks to delegate work to Claude Code, Codex, a custom agent, or another headless agent through the orchestrator CLI; when managing multiple background agents; or when installing and learning the Orchestrator CLI.
---

# Orchestrator

Use this skill to manage background agents through the `orchestrator` CLI. Treat
Orchestrator like a small job-control tool for agents: launch work, keep the
task id, watch progress, read the answer, inspect logs/events, and stop work
that no longer matters.

## Check Or Install

Start by checking whether the CLI exists:

```sh
orchestrator --help
```

If it is missing and npm is available, install the CLI:

```sh
npm install -g @backnotprop/orchestrator-cli
```

Then run:

```sh
orchestrator help --json
```

Use `help --json` as the current contract. It lists available runtimes,
commands, options, examples, and agent-facing instructions. Do not assume Claude
Code, Codex, or any custom runtime is available; config can hide runtimes.

## Basic Workflow

Launch a named background task:

```sh
orchestrator launch codex --name "inspect store" --model gpt-5.4-mini --json "Inspect the task store."
```

Capture `taskId` from stdout. Use that id for all follow-up commands:

```sh
orchestrator list --json
orchestrator watch <task-id>
orchestrator read <task-id>
orchestrator logs <task-id> --follow
orchestrator events <task-id> --agent-only --json
orchestrator interrupt <task-id> --reason "no longer needed"
```

Use `read` for the final answer. Use `watch` for a live task timeline. Use
`logs` for raw stdout/stderr. Use `events` for normalized task and agent events.

## Runtime Choices

Common first-release runtimes are:

```sh
orchestrator launch claude-code --name "review tests" --model sonnet "Find missing tests."
orchestrator launch codex --name "inspect store" --model gpt-5.4-mini "Inspect the task store."
```

Custom agents launch by their configured runtime id:

```sh
orchestrator launch custom-email --name "check email" --model glm-5.2 "Clean my inbox."
```

If a runtime is unknown, run `orchestrator help --json` and use one of the
listed runtime ids. If no runtime is available, tell the user clearly instead
of guessing.

## Good Agent Behavior

- Use `--json` when another program or agent needs to parse output.
- Use `--name` so task lists remain readable.
- Launch separate tasks for separate delegated jobs.
- Do not block on long-running work unless the user asks; launch, then watch or
  read later.
- Stop stale or duplicated work with `interrupt`.
- Report the task id, runtime, model, and current status when handing work back.
