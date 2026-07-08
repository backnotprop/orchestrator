# Spec: GitHub Copilot CLI Supported Runtime

Date: 2026-07-07

## Goal

Add GitHub Copilot CLI as a first-class Orchestrator runtime.

The first version should let users and agents run:

```sh
orchestrator launch copilot --name "review api" --model claude-sonnet-5 \
  "Review the API package."
```

and later:

```sh
orchestrator resume <task-id> "Continue from the prior result."
```

## Non-Goals

- Do not implement ACP yet.
- Do not add persistent Copilot sessions yet.
- Do not add live steering for Copilot yet.
- Do not build a generic provider-args system in this slice.
- Do not expose Copilot custom agents through a first-class Orchestrator flag
  yet.

## Runtime Behavior

Add a built-in runtime id:

```text
copilot
```

The runtime launches Copilot in official programmatic mode:

```sh
copilot -p "<task>"
```

The default runtime should be autonomous because Orchestrator runs background
agents:

```sh
copilot --no-ask-user --yolo --output-format json --stream off -p "<task>"
```

Text mode should be available for diagnostics:

```sh
copilot --no-ask-user --yolo -s -p "<task>"
```

## Runtime Config

Update `packages/core/src/runtime/types.ts`:

- add `"copilot"` to `BUILT_IN_RUNTIME_IDS`;
- widen `AgentLaunchPlan.resume.provider` to include `"copilot"`.

Update `packages/core/src/runtime/runtimes.ts`:

```ts
export const COPILOT_RUNTIME = {
  id: "copilot",
  displayName: "GitHub Copilot CLI",
  enabled: true,
  detect: {
    command: "copilot",
    versionArgs: ["--version"],
    expectedProcesses: ["copilot"],
  },
  launch: {
    executable: "copilot",
    baseArgs: ["--no-ask-user", "--yolo"],
    prompt: { kind: "flag", flag: "-p" },
    output: { kind: "stdout_text" },
    defaultOutputMode: "jsonl",
    outputModes: {
      text: {
        extraArgs: ["-s"],
        output: { kind: "stdout_text" },
      },
      jsonl: {
        extraArgs: ["--output-format", "json", "--stream", "off"],
        output: { kind: "jsonl_events", finalEvent: "result" },
      },
    },
    cwdPolicy: "workspace",
    modelFlag: "--model",
  },
  resume: { supported: true, args: ["--resume"] },
  control: {
    interrupt: "process_group",
    steerRunning: false,
  },
  capabilities: {
    supportsStreaming: true,
    supportsRunningSteer: false,
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsWorktree: true,
    handlesOwnAuth: true,
  },
  defaults: {
    timeoutMs: 900_000,
    maxOutputBytes: 200_000,
    isolation: "shared",
  },
} satisfies HeadlessAgentRuntimeConfig;
```

Add it to `BUILT_IN_AGENT_RUNTIMES`.

## Launch Plan Changes

Update `packages/core/src/runtime/launch-plan.ts`.

Add a Copilot branch:

```ts
case "copilot":
  return buildCopilotResumePlan(input, runtime);
```

Implement:

```ts
function buildCopilotResumePlan(
  input: BuildAgentResumeLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
): AgentLaunchPlan;
```

Rules:

- require `input.provider.sessionId`;
- throw `missing_resume_provider_id` if absent;
- build args in this shape:

```text
--no-ask-user --yolo --resume <session-id> --model <model> --output-format json --stream off -p <task>
```

Use the same output mode resolution as Claude/Codex.

Provider metadata:

```ts
resume: {
  provider: "copilot",
  sessionId,
}
```

Update unsupported resume hint to include Copilot.

## Output Normalization

Update `packages/core/src/tasks/output-adapters.ts`.

Add Copilot-specific handling:

```ts
if (runtime === "copilot") {
  return normalizeCopilotEvent(runtime, event);
}
```

Add final result text extraction:

- For `assistant.message`, read `data.content`.
- Store latest assistant message as `resultText`.
- `result` is the final event, but it does not contain the answer.

Normalize these event types:

### `assistant.message`

Output:

```ts
{
  kind: "agent.message",
  sourceType: "assistant.message",
  message: data.content,
  model: data.model,
  sessionId,
  usage: {
    outputTokens: data.outputTokens,
    source: "provider",
    scope: "turn",
    final: false,
  }
}
```

### `assistant.message_delta`

Output:

```ts
{
  kind: "agent.message_delta",
  message: data.deltaContent
}
```

### `assistant.turn_start` / `assistant.turn_end`

Output:

```ts
{
  kind: "agent.turn_start" | "agent.turn_end",
  model: data.model,
  turnId: data.turnId
}
```

### `result`

Output:

```ts
{
  kind: "agent.result",
  status: exitCode === 0 ? "succeeded" : "failed",
  sessionId,
  usage: normalized usage from result.usage
}
```

If `exitCode` is nonzero, mark the adapter result as failed.

### Session Events

Keep session events readable but compact:

```ts
kind: "runtime.session"
sourceType: "session.mcp_servers_loaded" | ...
message: useful summary when available
```

Avoid dumping large skill/MCP payloads into normalized event messages.

## Provider Metadata

Update provider extraction:

- for `runtime === "copilot"` and normalized event includes `sessionId`,
  return:

```ts
{
  provider: ("copilot", sessionId);
}
```

Update provider mismatch logic so Copilot resume verifies the returned
`sessionId` when Copilot emits one.

## Usage Mapping

Copilot does not emit the same token data as Claude/Codex.

Map what is available:

- `assistant.message.data.outputTokens` -> `outputTokens`
- `result.usage.sessionDurationMs` -> event field, not token usage
- `result.usage.totalApiDurationMs` -> event field, not token usage
- `result.usage.premiumRequests` -> event field, not token usage

Use the shared Orchestrator usage contract. Store provider-reported token fields
exactly, then let the existing usage normalizer compute totals only when it has
enough real token components to do so.

For Copilot v1 this means:

- if Copilot reports only `outputTokens`, store `outputTokens` and leave
  `totalTokens` absent;
- if Copilot later reports input tokens and output tokens, the normalizer may
  compute `totalTokens`;
- if Copilot reports `totalTokens` directly, store that value;
- do not turn `premiumRequests`, duration fields, quota, credits, or account
  data into task token counts.

This keeps `ps`, `read`, and future TUI output useful without pretending
Copilot reported metrics it did not report.

If Copilot later emits input tokens or total tokens, map them through the
existing `normalizeTaskUsage` path.

## CLI Behavior

No new CLI commands are required.

Existing commands should work:

```sh
orchestrator launch copilot "Review this repo."
orchestrator launch copilot --model claude-sonnet-5 "Review this repo."
orchestrator launch copilot --output-mode text "Say hello."
orchestrator read <task-id>
orchestrator events <task-id> --agent-only
orchestrator ps
orchestrator resume <task-id> "Continue."
orchestrator interrupt <task-id>
```

`--session` should reject Copilot:

```text
Runtime "copilot" does not support persistent sessions.
```

## Tests

Add fake Copilot CLI tests.

Recommended files:

- `test/runtime.test.ts`
- `test/cli-launch.test.ts`
- `test/cli-resume.test.ts`
- `test/cli-contract.test.ts`

Required test cases:

1. Runtime registry includes `copilot`.
2. Launch plan builds:
   - `copilot --no-ask-user --yolo --output-format json --stream off -p <task>`
   - `--model <model>` when provided.
3. Text mode reads plain output.
4. JSONL mode extracts answer from `assistant.message.data.content`.
5. JSONL mode stores provider `{ provider: "copilot", sessionId }`.
6. JSONL mode maps output tokens when present.
7. JSONL mode does not create `totalTokens` from output-only Copilot usage.
8. Nonzero final `result.exitCode` fails the task.
9. Resume builds a new task from stored Copilot `sessionId`.
10. Resume rejects Copilot tasks without `sessionId`.
11. Help/doctor output includes `copilot`.
12. Config can disable built-in `copilot`.

Add optional live smoke:

```text
RUN_COPILOT_SMOKE=1
```

Keep it short:

```sh
orchestrator launch copilot --wait --json --compact --brief \
  "Reply with exactly: hello from copilot"
```

## Docs

Update:

- `README.md`
- `skills/orchestrator/SKILL.md`
- `packages/cli/src/commands/help.ts`
- `doc/copilot.md`

Docs should say:

- `copilot` uses GitHub Copilot CLI.
- It is a process runtime like Claude Code.
- It uses `copilot -p` under the hood.
- It runs autonomously in the target workspace.
- It supports resume through Copilot session ids.
- It is not ACP.
- ACP may become a separate runtime later.

## Skill Guidance

The Orchestrator skill should tell agents:

- Use `copilot` when the user specifically asks for GitHub Copilot CLI or when
  Copilot is the desired backend.
- Use `copilot` for one-shot or resumable Copilot work.
- Use `resume` for follow-up work when the Copilot task finished and stored a
  session id.
- Do not use `send`, `goal`, or `--session` with `copilot`.
- Use `codex-app-server --session` when live steering or native Codex goals are
  needed.

## Open Product Question

Should Copilot permissions be configurable from Orchestrator CLI?

This spec says no for the first slice. The built-in runtime is autonomous by
default. A later provider-args feature can support stricter or custom Copilot
permission profiles.

## References

- `adr/research/SPIKE-github-copilot-cli-supported-runtime-20260707-172626.md`
- `adr/research/synthesis-github-copilot-cli-supported-runtime-20260707-173501.md`
