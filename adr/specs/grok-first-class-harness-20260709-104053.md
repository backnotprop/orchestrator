# Spec: Grok First-Class Harness

Date: 2026-07-09

## Goal

Add Grok Build as a first-class Orchestrator runtime.

The first version should let users and agents run:

```sh
orchestrator launch grok --name "review api" --model grok-code-fast-1 \
  "Review the API package."
```

and later:

```sh
orchestrator resume <task-id> "Continue from the prior result."
```

## Non-Goals

- Do not implement Grok ACP yet.
- Do not add persistent Grok sessions yet.
- Do not add running messages or live steering for Grok yet.
- Do not add Grok goals.
- Do not add a Grok provider-limit reader in this slice.
- Do not build a generic provider-args system in this slice.
- Do not expose `--always-approve`, `--no-subagents`, or
  `--disable-web-search` as first-class Orchestrator flags yet.

## Runtime Behavior

Add a built-in runtime id:

```text
grok
```

The runtime launches Grok in headless prompt mode:

```sh
grok --no-auto-update --output-format streaming-json -p "<task>"
```

Text mode should be available for diagnostics:

```sh
grok --no-auto-update --output-format plain -p "<task>"
```

JSON mode should be available for provider-specific diagnostics:

```sh
grok --no-auto-update --output-format json -p "<task>"
```

Orchestrator should set the process `cwd` through the launch plan. Do not pass
Grok's `--cwd` in the first built-in runtime unless a later test proves it is
needed.

## Runtime Config

Update `packages/core/src/runtime/types.ts`:

- add `"grok"` to `BUILT_IN_RUNTIME_IDS`;
- widen `AgentLaunchPlan.resume.provider` to include `"grok"`.

Update `packages/core/src/runtime/runtimes.ts`:

```ts
export const GROK_RUNTIME = {
  id: "grok",
  displayName: "Grok Build",
  enabled: true,
  detect: {
    command: "grok",
    versionArgs: ["version"],
    expectedProcesses: ["grok"],
  },
  launch: {
    executable: "grok",
    baseArgs: ["--no-auto-update"],
    prompt: { kind: "flag", flag: "-p" },
    output: { kind: "stdout_text" },
    defaultOutputMode: "streaming_json",
    outputModes: {
      text: {
        extraArgs: ["--output-format", "plain"],
        output: { kind: "stdout_text" },
      },
      json: {
        extraArgs: ["--output-format", "json"],
        output: { kind: "stdout_json" },
      },
      streaming_json: {
        extraArgs: ["--output-format", "streaming-json"],
        output: { kind: "jsonl_events", finalEvent: "end" },
      },
    },
    cwdPolicy: "workspace",
    modelFlag: "-m",
  },
  resume: { supported: true },
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
    supportsPersistentSession: false,
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

Add a Grok branch:

```ts
case "grok":
  return buildGrokResumePlan(input, runtime);
```

Implement:

```ts
function buildGrokResumePlan(
  input: BuildAgentResumeLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
): AgentLaunchPlan;
```

Rules:

- require `input.provider.sessionId`;
- throw `missing_resume_provider_id` if absent;
- build args in this shape:

```text
--no-auto-update --resume <session-id> -m <model> --output-format streaming-json -p <task>
```

Use the same output mode resolution as the other process runtimes.

Provider metadata:

```ts
resume: {
  provider: "grok",
  sessionId,
}
```

Update the unsupported resume hint to include Grok.

## Output Normalization

Update `packages/core/src/tasks/output-adapters.ts`.

Add Grok-specific handling:

```ts
if (runtime === "grok") {
  return normalizeGrokEvent(runtime, event);
}
```

Add final result text extraction:

- Add a Grok result accumulator to the JSONL adapter.
- For streaming JSON `text` events, append `data` to that accumulator.
- Do not set the task result from partial `text` chunks.
- For the `end` event, set the task result to the accumulated text.
- For JSON mode, read top-level `text` when the generic JSON adapter is used.

Normalize these streaming event types:

### `text`

Input:

```json
{"type":"text","data":"OK"}
```

Output:

```ts
{
  kind: "agent.message_delta",
  sourceType: "text",
  message: data,
}
```

The adapter must append `data` to the task result.
It must not mark the task as having a final result yet.

### `thought`

Input:

```json
{"type":"thought","data":"..."}
```

Output:

```ts
{
  kind: "agent.reasoning_delta",
  sourceType: "thought",
  message: data,
}
```

### `end`

Input:

```json
{"type":"end","stopReason":"EndTurn","sessionId":"...","requestId":"..."}
```

Output:

```ts
{
  kind: "agent.result",
  sourceType: "end",
  status: "succeeded",
  terminalReason: stopReason,
  sessionId,
  requestId,
}
```

### `error`

If Grok emits an error event, normalize it to:

```ts
{
  kind: "runtime.error",
  sourceType: "error",
  message,
  sessionId,
}
```

Do not dump large provider payloads into normalized event messages.

The task should fail if Grok emits chunks but never emits `end`.

## Provider Metadata

Update provider extraction:

- for `runtime === "grok"` and normalized event includes `sessionId`, return:

```ts
{
  provider: "grok",
  sessionId,
}
```

Update provider mismatch handling so resumed Grok tasks fail if Grok reports a
different `sessionId` than the one Orchestrator requested.

Default `streaming_json` mode must store provider metadata. `json` output mode
may be treated as diagnostic unless the implementation also teaches the
`stdout_json` adapter to store Grok provider metadata.

## Tests

Update `test/runtime.test.ts`:

- built-in runtime ids include `grok`;
- Grok default launch uses `grok --no-auto-update --output-format
  streaming-json -p <task>`;
- `--model` maps to `-m <model>`;
- text, JSON, and streaming JSON output modes resolve correctly;
- Grok resume builds args with `--resume <session-id>`;
- Grok resume requires `provider.sessionId`;
- unsupported resume hints mention Grok.

Update `test/tasks.test.ts`:

- Grok streaming chunks produce final output `GROK_OK`;
- `end.sessionId` persists as provider metadata;
- resumed Grok task checks provider session mismatch;
- Grok error events fail the task;
- malformed Grok JSONL without `end` fails the task.

Add fixtures as needed:

```text
test/fixtures/grok-streaming-json.jsonl
test/fixtures/grok-error-jsonl.jsonl
```

Update CLI/help tests:

- `orchestrator help` includes `grok`;
- compact help includes `grok` in `runtimeIds`;
- agent runtime-choice instructions include Grok for AI work;
- launch examples include a Grok example when the runtime is enabled.

Add a skipped live smoke test:

```sh
RUN_GROK_SMOKE=1 node --experimental-strip-types --test test/grok-smoke.test.ts
```

The smoke should:

- require `grok` on PATH;
- launch Grok with a short exact-answer prompt;
- assert the final answer;
- assert provider metadata includes `provider: "grok"` and `sessionId`;
- optionally resume that task and assert the resumed answer.

## Docs

Update:

- `README.md`
- `skills/orchestrator/SKILL.md`
- CLI help text and compact help JSON expectations

Docs should say:

- `grok` is the process runtime backed by Grok Build headless mode;
- use it when Grok is the desired backend for one-shot or resumable AI work;
- default output mode is the reliable mode for final answers, provider ids,
  token usage when available, and resume;
- ACP is not part of this slice.

## Acceptance Criteria

- `orchestrator launch grok ...` builds the expected launch plan.
- A Grok streaming JSON fixture produces a readable final result.
- Grok `sessionId` is stored in task provider metadata.
- `orchestrator resume <grok-task>` builds a Grok resume plan.
- Help, README, and the Orchestrator skill include Grok in first-class runtime
  guidance.
- `pnpm check` passes.
