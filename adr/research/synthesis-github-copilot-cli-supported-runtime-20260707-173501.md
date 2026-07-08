# Synthesis: GitHub Copilot CLI as a Supported Runtime

Date: 2026-07-07

## Summary

GitHub Copilot CLI should be added to Orchestrator as a first-class process
runtime first.

The useful first version is:

```sh
orchestrator launch copilot --name "review api" --model claude-sonnet-5 \
  "Review the API package."
```

Under the hood, that should run Copilot through its official programmatic CLI
surface:

```sh
copilot -p "<task>"
```

This matches the Claude Code path more than the Codex app-server path. Copilot
starts, runs a task, emits output, and exits. Orchestrator stores the task,
events, logs, result, provider session id, and usage data where available.

## What We Learned

Copilot CLI has three relevant surfaces:

1. `copilot -p`
   - Official one-shot programmatic mode.
   - Good fit for Orchestrator's existing process runtime.
   - Supports model selection, JSONL output, custom Copilot agents, permissions,
     and resume.

2. `copilot --resume <session-id> -p`
   - Continues a saved Copilot session.
   - Local probe confirmed this works.
   - Good fit for Orchestrator's existing `resume` command.

3. `copilot --acp --stdio`
   - Starts Copilot as an ACP server.
   - Promising for persistent sessions and richer client control.
   - Public preview and a different protocol than Codex app-server.
   - Should be a separate future runtime, not mixed into the first `copilot`
     process runtime.

## Recommendation

Implement `copilot` as a process runtime first.

Do not start with ACP. It would slow down the first useful integration and pull
in a new protocol before we have proven basic Copilot orchestration.

The first implementation should support:

- launch
- wait/background task management
- JSONL event capture
- normalized final answer
- provider session id
- resume
- model selection
- usage display where Copilot emits usable numbers

## Permission Decision

Copilot CLI is permission-driven. For background orchestration, a Copilot task
cannot sit around waiting for interactive approvals.

The first built-in runtime should be explicitly autonomous:

```sh
copilot --no-ask-user --yolo --output-format json --stream off -p "<task>"
```

Reason:

- Orchestrator launches background agents.
- Background agents need to finish or fail without asking the terminal user.
- A conservative Copilot runtime would be technically safer but less useful for
  the actual product.

This must be documented plainly. `copilot` means Orchestrator is allowing
Copilot CLI to operate as an autonomous local agent in the target workspace.

If users want stricter Copilot permissions later, that should be handled through
one of these paths:

- custom runtime config;
- future runtime permission options;
- a second conservative runtime profile.

Do not block first support on a general provider-args system.

## Required Orchestrator Changes

The codebase already has the right seams:

- built-in runtime registry in `packages/core/src/runtime/runtimes.ts`;
- runtime id list in `packages/core/src/runtime/types.ts`;
- process launch plan builder in `packages/core/src/runtime/launch-plan.ts`;
- generic process supervision;
- JSONL output adapter in `packages/core/src/tasks/output-adapters.ts`;
- existing provider metadata and resume flow.

The important missing pieces are:

- `copilot` built-in runtime id/config;
- Copilot-specific JSONL result/event normalization;
- Copilot provider metadata extraction from `result.sessionId`;
- Copilot resume launch-plan support;
- tests and docs.

## Shape of the Runtime

The likely runtime config:

```ts
id: "copilot"
displayName: "GitHub Copilot CLI"
detect.command: "copilot"
launch.executable: "copilot"
launch.baseArgs: ["--no-ask-user", "--yolo"]
launch.prompt: { kind: "flag", flag: "-p" }
launch.defaultOutputMode: "jsonl"
launch.outputModes.jsonl.extraArgs: ["--output-format", "json", "--stream", "off"]
launch.outputModes.text.extraArgs: ["-s"]
launch.modelFlag: "--model"
resume.supported: true
control.interrupt: "process_group"
```

## Current Unknowns

- Copilot token data is not as clean as Claude/Codex. The local probe showed
  output tokens and premium requests, not a full input/output/cache token model.
- Copilot JSONL is noisy. We need normalization so `events --agent-only` stays
  readable.
- `--agent <agent>` is useful, but Orchestrator does not yet have a generic
  provider-specific args surface. That can come later.
- ACP is useful, but it should not be part of the first implementation.

## Slices

1. Add built-in `copilot` runtime.
2. Normalize Copilot JSONL and provider metadata.
3. Add Copilot resume support.
4. Update docs, help, and skill guidance.
5. Add opt-in live smoke test.
6. Consider `copilot-acp` only after process mode is solid.

## References

- `adr/research/SPIKE-github-copilot-cli-supported-runtime-20260707-172626.md`
- GitHub Copilot CLI programmatic reference:
  https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- GitHub Copilot CLI command reference:
  https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- GitHub Copilot CLI ACP server:
  https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
