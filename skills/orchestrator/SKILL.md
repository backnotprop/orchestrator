---
name: orchestrator
description: Use Orchestrator to launch, watch, read, log, and interrupt background agent tasks from any agent environment. Use when the user asks to delegate work to Claude Code, Codex, a custom agent, or another headless agent through the orchestrator CLI; when managing multiple background agents; or when installing and learning the Orchestrator CLI.
---

# Orchestrator

Use this skill to manage background agents through the `orchestrator` CLI.
Orchestrator uses one default machine store at `~/.orchestrator/tasks`.
Workspace is project scope. `cwd` is where the agent process runs.

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
orchestrator help --json --compact
```

Use `help --json --compact` as the quick command contract. If you need the full
contract, run `orchestrator` with `fullHelp.args`, or run `orchestrator help
--json`. Do not assume Claude Code, Codex, or any custom runtime is available;
config can hide runtimes. Common options like `--workspace`,
`--orchestrator-dir`, `--config`, and `--json` may appear before or after the
command.

When runtime availability is uncertain, run:

```sh
orchestrator doctor --json --compact
```

Use `runtimeSummary.availableIds` to choose launchable runtime ids quickly.
If compact doctor returns `parent.canRun: true`, append the user request to
`parent.run.argsPrefix`, or use `parent.run.backgroundArgsPrefix` when the
parent run should be managed as a background task.

## First-Run Path

For normal delegation, use this path:

1. Check availability with `orchestrator doctor --json --compact` when runtime
   setup is uncertain.
2. Launch with `--json --compact --brief`.
3. Capture the returned `taskId` or `id`.
4. Prefer returned `commands.*.args` and `stop.args` for follow-up. Treat those
   arrays as argv arrays; do not join them into one shell string.
5. Read results with `read --wait --json --compact`.
6. Stop work that is stale, duplicated, or no longer needed.

Normal one-agent delegation:

```sh
orchestrator launch codex --name "inspect store" --model gpt-5.4-mini --json --compact --brief "Inspect the task store."
orchestrator read <task-id|prefix> --wait --json --compact
```

Use Claude Code, Codex, or Copilot for AI work such as code review,
implementation, research, repo inspection, or analysis. Use `shell` for exact
local commands. Do not launch an AI runtime just to run a deterministic shell
command.

## Many Agents

Use `launch -f <manifest.json|-> --json --compact --brief` when several tasks
should start in one call. The manifest must include `schemaVersion: 1`.

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

```sh
orchestrator launch -f agents.json --json --compact --brief
orchestrator ps --json --compact --active --brief
orchestrator read <task-id|prefix> <task-id|prefix> --wait --json --compact
```

Use the top-level `commands.waitPreview.args` from compact `ps` to wait for the
listed tasks without polling. If active compact `ps` is empty after short work,
run `views.recent.args` from the compact response.

## Orchestrator As Parent

Start Orchestrator itself as a managed parent task when it should coordinate
child agents for you:

```sh
orchestrator run --background --name "repo plan" --json --compact "Launch child agents as needed, wait for them, then summarize."
```

If compact doctor returns `parent.canRun: true`, append the user request to the
returned `parent.run.argsPrefix` or `parent.run.backgroundArgsPrefix` instead of
constructing `run --agent-dir` by hand.

## Persistent Codex Sessions And Goals

Use `codex` for short, one-shot Codex tasks where a single prompt should finish
the work. Prefer `codex-app-server --session` for meaningful or long-running
Codex work, especially when the task may need follow-up messages, native Codex
goals, steering while a turn is active, protocol events, provider metadata, or
closer observation. One-shot `codex-app-server` tasks use a stdio app-server
process. `codex-app-server --session` uses an Orchestrator-managed
`codex app-server --listen unix://<socket>` backend and one Codex provider
thread per Orchestrator task.

Start a persistent Codex app-server session:

```sh
orchestrator launch codex-app-server --session --name "performance worker" --model gpt-5.4-mini --json --compact --brief
```

Then use the returned task id:

```sh
orchestrator send <task-id|prefix> --wait --json --compact "Inspect current performance bottlenecks."
orchestrator goal start <task-id|prefix> --wait --json --compact "Improve performance across the app by 10%."
orchestrator goal get <task-id|prefix> --json --compact
orchestrator goal set <task-id|prefix> --status paused --json --compact
orchestrator goal clear <task-id|prefix> --json --compact
orchestrator send <task-id|prefix> --wait --json --compact "Summarize what changed."
orchestrator interrupt <task-id|prefix> --json --compact --reason "session complete"
```

Use `goal start` only when the provider should actively work on a native goal.
Do not set a goal token budget by default; goals are open-ended provider work,
and a guessed budget can stop useful work early. Use `--token-budget` only when
you intentionally want a hard cap.
Use `goal get`, `goal set`, and `goal clear` to inspect or edit provider goal
state without starting work. Do not simulate provider goals by sending prompt
text. Use `send --wait` or `goal start --wait` when the next step depends on the
operation result.
Interrupting the session stops that Orchestrator task, not the shared Codex
app-server backend or unrelated session tasks.

## Follow-Up Commands

Use the id or a unique prefix shown by `ps` and `list`:

```sh
orchestrator ps --json --compact --active
orchestrator ps --json --compact --active --brief
orchestrator ps -A --json --compact --active --brief
orchestrator resume <task-id> --json --compact "Continue from the prior result."
orchestrator watch <task-id> --agent-only --json
orchestrator read <task-id>... --wait --json --compact
orchestrator logs <task-id> --follow
orchestrator events <task-id> --agent-only --json --compact
orchestrator interrupt <task-id> <task-id> --reason "no longer needed" --json --compact
orchestrator interrupt <task-id> --reason "no longer needed" --json
```

Use `ps --json --compact --active` to find running tasks and stop targets in the
current workspace. Use `ps -A --json --compact --active --brief` to scan active
work across the machine. Use `ps --parent <run-id|prefix> --json --compact
--brief` when follow-up should stay scoped to one parent run. Build your own
multi-task wait with `read <id> <id> --wait --json --compact`. Use
`watch --agent-only --json` for normalized live events. Use `logs` for raw
stdout/stderr. Use `events` for normalized task and agent events.
Use `resume <task-id> --json --compact` only when you need true provider resume
from a finished Codex, Claude Code, or Copilot task.
Resume needs stored provider metadata. Keep the default runtime output mode when
you want reliable results, provider ids, token usage, or resume. Provider text
modes are mainly diagnostic or provider-specific.

## Cleanup

Prefer returned `stop.args` from JSON output when stopping tasks or groups.

Stop selected work:

```sh
orchestrator interrupt <task-id|prefix> <task-id|prefix> --json --compact --reason "no longer needed"
```

Stop all active work in the current workspace only when that is intentional:

```sh
orchestrator interrupt --active --json --compact --reason "cleanup"
```

Stop active work across all workspaces only when the user clearly asked for
machine-wide cleanup:

```sh
orchestrator interrupt -A --active --yes --json --compact --reason "cleanup"
```

## Runtime Choices

Common first-release runtimes are:

```sh
orchestrator launch claude-code --name "review tests" --model sonnet --json --compact "Find missing tests."
orchestrator launch codex --name "inspect store" --model gpt-5.4-mini --json --compact "Inspect the task store."
orchestrator launch copilot --name "review repo" --json --compact "Review this repo."
```

Use `shell` for exact local shell commands and small local utility tasks:

```sh
orchestrator launch shell --name "local check" --json --compact 'printf "OK\n"'
```

Do not launch an AI runtime just to run a deterministic shell command. Use
Codex, Claude Code, or Copilot for AI work such as code review, implementation,
research, repo inspection, or analysis.

Custom agents launch by their configured runtime id:

```sh
orchestrator launch custom-email --name "check email" --model glm-5.2 --json --compact "Clean my inbox."
```

If a runtime is unknown, run `orchestrator help --json --compact` and use one
of the listed `runtimeIds`. If no runtime is available, tell the user clearly
instead of guessing.

## Good Agent Behavior

- Use `--json --compact --brief` for single launch when you only need
  id/status/stop.
- Prefer `launch -f <manifest.json|-> --json --compact --brief` when you need
  to start several tasks at once.
- Use `shell` for exact local shell commands and small local utility tasks. Put
  the command itself in the task instructions.
- Use `codex`, `claude-code`, or `copilot` for AI work such as code review,
  implementation, research, repo inspection, or analysis.
- Prefer `codex-app-server --session` over `codex` when Codex work is
  long-running, important, likely to need follow-up, or needs native goals.
- Do not launch an AI runtime just to run a deterministic shell command.
- Use `resume` only for true provider resume from a finished Codex or Claude
  Code or Copilot task. For other runtimes, launch a new task with explicit context.
  Resume needs stored provider metadata. Keep the default runtime output mode
  when you want reliable results, provider ids, token usage, or resume.
  Provider text modes are mainly diagnostic or provider-specific.
- Use `help --json --compact` for quick discovery; use `fullHelp.args` when you
  need the full contract.
- Use `doctor --json --compact` when runtime availability is uncertain.
- If compact doctor returns `parent.canRun: true`, append the user request to the
  returned args prefix instead of constructing `run --agent-dir` by hand.
- Put common options before or after the command. Portable args returned by
  Orchestrator can be passed directly after the `orchestrator` binary.
- Use `ps --json --compact --active` to find running work and stop targets in
  the current workspace.
- Use `ps --json --compact --active --brief` to scan many running tasks with
  less JSON.
- Use `ps -A --json --compact --active --brief` to scan active tasks across all
  workspaces.
- Use `ps --parent <run-id|prefix> --json --compact --brief` when you need one
  parent run and its children.
- If active compact `ps` is empty after short work, use
  `views.recent.args` from the compact response to recover recent finished tasks
  and batch read commands.
- After starting several tasks, use `ps --json --compact --brief` and top-level
  `commands.waitPreview.args` to collect the listed set.
- Prefer portable `commands.*.args` from JSON output when reading, watching,
  logging, or inspecting events.
- Treat returned args arrays as argument vectors. Do not collapse several task
  ids into one quoted string.
- If JSON lookup errors include `recovery.views.*.args`, run those args to
  recover from missing or ambiguous task/group ids.
- Use compact `ps` top-level `commands.waitPreview.args` when you need to wait
  for every task in that compact view.
- Use compact `ps` group `commands.waitPreview.args` when you need to wait for
  one listed parent/group instead of every task in the view.
- Use task-level `commands.read.args` for an immediate JSON read and
  `commands.wait.args` when you need to wait for one task.
- Use `read <id> <id> --wait --json --compact` when you need to build your own
  multi-task wait call.
- If compact `read` returns `active: true`, use `commands.waitPreview.args` to
  wait with bounded output or `commands.readPreview.args` to poll again.
- If compact batch `read` times out, use top-level `commands.waitPreview.args`
  to wait again or `stop.args` to stop still-active work safely.
- If compact `read` returns failed status, use `commands.logsPreview.args` for
  bounded raw logs or `commands.events.args` for the task timeline.
- Use `logs --json --compact` for a one-line raw stdout/stderr snapshot and
  `events --json --compact` for a one-line task timeline.
- Use `logs --follow --stream all` when you need live raw output with stdout and
  stderr order preserved.
- If compact `read` is truncated by read limit, use `commands.read.args` to
  fetch more output.
- Use `commands.watch.args` for the full live event stream and
  `commands.agentWatch.args` for normalized live agent events only.
- Prefer portable `stop.args` from JSON output when stopping tasks or groups.
  Compact views use concise `interrupt --json --compact` stop results.
- Compact `ps` `stop.args` is scoped to the current view; parent/group stops may
  include children of that selected run.
- Use `interrupt <id> <id> --json --compact` to stop a selected subset of
  tasks without stopping the whole workspace.
- Use `interrupt --active --json --compact` only when all active work in the
  selected workspace should be stopped. It is safe when none are active.
- Use `interrupt -A --active --yes --json --compact` only when all active work
  across all workspaces should be stopped.
- Use `ps --all --json --compact` when you need compact full task history for
  the current workspace.
- Use `ps -A --all --json --compact` when you need compact full task history
  across all workspaces.
- Use `read --wait --json --compact` when you need to wait for status, `exitCode`,
  output, usage, and errors in one object.
- Check `outputTruncated`, `stdoutTruncated`, and `stderrTruncated` in JSON
  output. `ByReadLimit` means re-read with more bytes can help; `ByCaptureLimit`
  means the task was launched with too small a capture cap.
- Use `watch --agent-only --json` for normalized agent events; use
  `logs --follow` for raw output.
- If a `--json` command exits non-zero, parse stderr as JSON. Use `reason`,
  `input`, `matches`, and `hint` when present to recover.
- Use `--name` so task lists remain readable.
- Launch separate tasks for separate delegated jobs.
- Do not block on long-running work unless the user asks; launch, then watch or
  use `read <id> <id> --wait --json --compact`.
- Stop stale or duplicated work with `interrupt`; pass multiple ids when stopping
  a selected subset.
- Report the task id, runtime, model, and current status when handing work back.
