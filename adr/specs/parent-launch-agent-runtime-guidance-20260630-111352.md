# Parent launch_agent Runtime Guidance

Date: 2026-06-30

## Goal

Make the parent Orchestrator agent choose `shell` for exact local commands and
choose Codex or Claude Code for AI work.

## Problem

Manual smoke testing showed that the parent can choose a model runtime when the
user asked for a shell/local-command child. That wastes time and budget. The
system worked, but the parent guidance was too vague.

## Scope

This slice updates guidance only. It should not change runtime execution,
launch plans, task storage, or custom runtime loading.

## User-Facing Rule

Teach agents this simple split:

- `shell`: exact local shell commands and small local utility tasks.
- `codex` / `claude-code`: AI work such as code review, implementation,
  research, repo inspection, and analysis.
- custom runtime ids: use them when the user names one or the runtime is clearly
  known from context.

The key instruction:

> Do not launch Codex or Claude just to run a deterministic shell command.

## Code Changes

1. Update `packages/agent/src/instructions.ts`.
   - Add a short "Choose the runtime" paragraph.
   - Mention `runtime: "shell"` directly.
   - Keep wording simple and command-like.

2. Update `packages/agent/src/tools.ts`.
   - Change `launch_agent` description to include the built-in `shell` runtime.
   - Add `promptGuidelines` for runtime choice.
   - Do not change the tool schema to a static enum.

3. Update agent-facing CLI docs.
   - Add the same runtime-choice rule to `skills/orchestrator/SKILL.md`.
   - Add it to `packages/cli/src/commands/help.ts` agent instructions so
     `orchestrator help --json --compact` teaches external agents the same
     behavior.

4. Optionally update `README.md`.
   - Only if the public runtime section can say this cleanly without making the
     README noisy.

## Tests

Add focused tests:

- `buildOrchestratorParentPrompt(...)` includes `runtime: "shell"` and the
  "do not launch Codex or Claude just to run a deterministic shell command"
  rule.
- `createOrchestratorAgentTools(...).find(name === "launch_agent")` exposes a
  description or prompt guideline that mentions `shell`.
- CLI help JSON or compact help includes the runtime-choice instruction if help
  is updated.

Manual smoke after implementation:

```sh
orchestrator run --trace-tools --agent-dir ~/.pi/agent \
  'Launch a shell child named "echo demo". Give it this exact task: printf "OK\n". Use read_agent with wait: true and report the output.'
```

Expected behavior:

- first `launch_agent` call uses `runtime="shell"`;
- child task succeeds;
- parent reports the child output.

## Non-Goals

- Do not add runtime auto-routing.
- Do not add a prompt classifier.
- Do not make `runtime` a static enum.
- Do not change `shell` execution semantics.
- Do not hide or rewrite explicit user runtime choices.

## Acceptance

This slice is done when the parent prompt, `launch_agent` metadata, skill docs,
and help contract all teach the same runtime-choice rule, and tests prove those
agent-facing surfaces contain the guidance.
