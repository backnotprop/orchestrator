# Synthesis: Parent launch_agent Runtime Guidance

Date: 2026-06-30

## Summary

The parent agent made a poor runtime choice because our own guidance was too
generic. We told it that `launch_agent` delegates work, but we did not teach the
simple runtime split:

- `shell` is for exact local commands;
- `codex` and `claude-code` are for AI work;
- custom runtimes are used when the user or config clearly names one.

The runtime layer already supports this. The missing piece is clearer guidance
where agents read it.

## Recommendation

Tighten the guidance, not the architecture.

Add a short runtime-choice section to the parent instructions and `launch_agent`
tool metadata. Mirror the same rule in the Orchestrator skill and CLI help
contract so external agents get the same guidance when they use the CLI
directly.

Recommended language:

- Use `runtime: "shell"` for exact local shell commands or small local utility
  tasks.
- Put the command itself in `instructions`.
- Use `runtime: "codex"` or `runtime: "claude-code"` for model work such as
  code review, implementation, research, repo inspection, or analysis.
- Use configured custom runtime ids only when the user names one or the runtime
  is known from context.
- Do not launch Codex or Claude just to run a deterministic shell command.

## Why Not More

Do not add a classifier or hidden runtime rewrite yet. That would be
over-engineering for the current failure. It would also be risky because custom
runtime ids are user-defined and the parent may have legitimate reasons to use
an AI runtime even when the request mentions commands.

Do not turn `runtime` into a static enum. The whole custom-agent model depends
on arbitrary runtime ids.

## Test Shape

Add focused tests that prove the guidance is present:

- parent prompt includes the shell-vs-model runtime rule;
- `launch_agent` tool metadata mentions `shell`;
- help JSON/compact help includes the runtime-choice rule if that surface is
  updated.

Then run one small manual parent smoke:

```sh
orchestrator run --trace-tools --agent-dir ~/.pi/agent \
  'Launch a shell child named "echo demo". Give it this exact task: printf "OK\n". Use read_agent with wait: true and report the output.'
```

Expected trace: the first `launch_agent` call uses `runtime="shell"`.
