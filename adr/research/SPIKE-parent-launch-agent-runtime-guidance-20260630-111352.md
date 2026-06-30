# Parent launch_agent Runtime Guidance

Date: 2026-06-30

## Question

What needs to change so the parent Orchestrator agent chooses the right runtime
for local shell work instead of launching Codex or Claude first?

## Context

A manual smoke pass found a bad parent-agent behavior: when asked to launch
shell children, the parent first launched Codex children that timed out, then
launched the intended shell children. The task system audited the mistake, but
the mistake should be less likely.

This is a guidance problem before it is a runtime problem. The `launch_agent`
tool accepts a free-form `runtime` string because custom runtimes are user
configurable. The parent has to choose a runtime from instructions and context.

## Current Surfaces

### Parent Prompt

`packages/agent/src/instructions.ts` tells the parent:

- it can start other agents;
- it should use child agents for background work;
- `launch_agent` starts a background task;
- `read_agent` should use `wait: true` when the answer is needed.

It does not explain which runtime to choose.

There is no statement like:

- use `runtime: "shell"` for exact local shell commands;
- use Codex or Claude Code for AI work;
- do not use Codex or Claude just to run deterministic local commands.

### launch_agent Tool Definition

`packages/agent/src/tools.ts` defines `launch_agent`.

Current description:

> Start a Claude Code, Codex, or configured custom agent as a background
> Orchestrator task.

This omits the built-in `shell` runtime, even though `shell` is enabled and used
in tests and manual smoke work.

Current `promptGuidelines` say:

- use `launch_agent` for delegation;
- keep instructions explicit;
- inspect the task after launch.

They do not explain runtime selection.

### CLI Skill / Help

`skills/orchestrator/SKILL.md` and `packages/cli/src/commands/help.ts` already
teach many agent-control patterns: compact JSON, returned args, resume, stopping
groups, and task inspection.

They mention `shell` as a runtime in some places and warn agents not to collapse
returned args into one shell string. They do not clearly say:

- `shell` is for exact local commands;
- Codex and Claude are for model work;
- custom runtimes should be used when explicitly configured or named.

### Runtime Registry

The runtime registry already models `shell` correctly:

- `shell` runs `sh -lc`;
- `shell` accepts local command text;
- `shell` is not resumable;
- `shell` has no structured model output.

No runtime code needs to change for this slice.

## Options

### Option 1: Instruction-Only Fix

Update the parent prompt, tool description, tool guidelines, help contract, and
skill docs.

Pros:

- smallest fix;
- matches the manual-smoke failure;
- no new classifier;
- no hidden runtime rewriting;
- safe with custom runtime ids.

Cons:

- still relies on the parent model following instructions.

### Option 2: Runtime Enum

Make `launch_agent.runtime` an enum of known runtimes.

Pros:

- stronger guidance in schema.

Cons:

- wrong for custom runtimes, because runtime ids are dynamic;
- would need per-run schema generation from loaded config;
- bigger than the problem.

### Option 3: Auto-Route Shell-Looking Instructions

Detect shell-looking prompts and rewrite `runtime` to `shell`.

Pros:

- could catch some mistakes.

Cons:

- brittle;
- surprising;
- can break explicit user intent;
- creates hidden behavior instead of clear agent guidance.

## Finding

Use Option 1 first. The right next patch is to make runtime choice explicit in
the surfaces agents actually read:

- parent prompt;
- `launch_agent` tool description and guidelines;
- Orchestrator skill;
- CLI help JSON/text contract.

Do not add automatic routing or hardcoded runtime schema in this slice.
