---
name: orchestrator
description: Use Orchestrator as a CLI-backed skill to delegate and coordinate work across Claude Code, Codex, Copilot, Grok, Pi, shell, and custom runtimes. Use when an agent should launch one or many sub-agents, choose runtimes or models, apply the user's orchestration preferences, inspect background work, collect results, resume sessions, or stop stale work.
---

# Orchestrator

Use Orchestrator to let the current agent coordinate other agents. The skill is
the interface; the `orchestrator` CLI is the deterministic control plane
underneath it.

## Start

1. Read `PREFERENCES.md` beside this file. Apply only non-comment content
   under `User Preferences`. `No preferences set.` means use judgment.
2. Follow an explicit instruction in the current user request before a stored
   preference.
3. Check the CLI with `orchestrator --help`. If missing and npm is available,
   install it with `npm install -g @backnotprop/orchestrator-cli`.
4. Run `orchestrator help --json --compact` for the current command contract.
5. Run `orchestrator doctor --json --compact` when runtime availability is
   uncertain. Choose only from `runtimeSummary.availableIds`.
6. Run `orchestrator models <runtime> --json --compact` before choosing an
   exact model value.

Do not assume a runtime or model exists because it appears in an example.

## Preferences

Preferences are routing policy for the calling agent. They may describe:

- which runtime or model to use for a type of work;
- which fallbacks to use and in what order;
- when to fan out or keep work with one agent;
- what to do when provider usage is exhausted.

Use this precedence:

1. explicit instructions in the current request;
2. `PREFERENCES.md`;
3. live runtime and provider facts;
4. your best judgment.

Map preference names to configured runtime and model values when unambiguous.
If the mapping is consequential and unclear, ask the user once. Preferences do
not grant permission for unrelated work and do not override task safety.

When preferences depend on usage, run `orchestrator limits --json --compact`.
Treat unavailable limit data as unknown, not exhausted. Follow configured
fallbacks only when the preferred choice is unavailable, exhausted, or fails
clearly. If the policy says to pause when all choices are exhausted, launch
nothing and notify the user.

## Choose Models

Omit `--model` when the user has no model requirement. The installed runtime
then chooses its current default.

Before passing an exact model value, run:

```sh
orchestrator models <runtime> --json --compact
```

- Match user requests and preference labels against `models[].id` or
  `models[].displayName`; pass the matched `id` to `--model`.
- Resolve "latest" or "best" through a returned `defaultModel`, `alias`, or
  `router`. Do not sort version-like names or guess from memory.
- Treat `partial` as useful but incomplete discovery. Claude Code, for example,
  exposes current family aliases instead of an exact catalog.
- If discovery is unavailable, omit `--model` unless the request requires an
  exact choice.
- Do not silently replace an unavailable exact model unless the current request
  or preferences define a fallback.
- Run the returned `fullModels.args` when descriptions or capabilities matter.

Model values remain provider-native and are passed through unchanged.

## Delegate One Job

Use a named task and keep its returned id:

```sh
orchestrator launch codex --name "inspect store" --json --compact --brief "Inspect the task store."
orchestrator read <task-id|prefix> --wait --json --compact
```

Use `shell` for exact local commands. Use an AI runtime for review,
implementation, research, exploration, or analysis.

## Fan Out

Launch separate tasks for independent work. Use a manifest when several tasks
should start together:

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "runtime": "claude-code",
      "name": "review tests",
      "task": "Find the highest-risk missing tests."
    },
    {
      "runtime": "grok",
      "name": "inspect api",
      "task": "Inspect the API boundary for bugs."
    }
  ]
}
```

```sh
orchestrator launch -f agents.json --json --compact --brief
orchestrator ps --json --compact --active --brief
orchestrator read <task-id> <task-id> --wait --json --compact
```

Do not collapse several task ids into one quoted string.

## Let Orchestrator Coordinate

Use the parent agent when the user wants Orchestrator itself to plan and manage
delegation:

```sh
orchestrator run --background --name "repo work" --json --compact "Delegate independent work, wait for every child, then synthesize the result."
```

If compact doctor returns `parent.canRun: true`, append the request to
`parent.run.argsPrefix` or `parent.run.backgroundArgsPrefix`.

## Operate The Work

```sh
orchestrator ps --json --compact --active --brief
orchestrator ps -A --json --compact --active --brief
orchestrator watch <task-id> --agent-only --json
orchestrator read <task-id>... --wait --json --compact
orchestrator logs <task-id> --follow
orchestrator events <task-id> --agent-only --json --compact
orchestrator resume <task-id> --json --compact "Continue from the prior result."
orchestrator interrupt <task-id> --json --compact --reason "no longer needed"
```

- Prefer portable `commands.*.args` and `stop.args` returned in JSON.
- Treat returned argument arrays as argv arrays.
- Use `read --wait` instead of repeated polling when the next step needs the
  result.
- Use `watch` for normalized live events and `logs` for raw provider output.
- Resume only finished tasks with stored provider metadata and runtime resume
  support.
- Stop stale, duplicated, or no-longer-needed work.
- Report task id, runtime, model, and status when handing work back.

## Runtime Notes

Built-in launch targets include `claude-code`, `codex`,
`codex-app-server`, `copilot`, `grok`, `pi`, and `shell`. Config may
disable built-ins or add custom runtime ids.

Use `codex` for one-shot Codex work. Prefer
`codex-app-server --session` when Codex work needs repeated messages, native
goals, steering, or a persistent provider thread:

```sh
orchestrator launch codex-app-server --session --name "deep worker" --json --compact --brief
orchestrator send <task-id> --wait --json --compact "Inspect the current bottlenecks."
orchestrator goal start <task-id> --wait --json --compact "Improve the system."
```

Do not set a goal token budget unless the user wants a hard cap.

## Cleanup Scope

Prefer exact task ids. Use workspace-wide cleanup only when intentional:

```sh
orchestrator interrupt --active --json --compact --reason "cleanup"
```

Use all-workspace cleanup only when the user explicitly requests it:

```sh
orchestrator interrupt -A --active --yes --json --compact --reason "cleanup"
```
