# Grok First-Class Harness Spike

Date: 2026-07-09

## Question

What would it take to support Grok Build as a first-class Orchestrator runtime?

## Sources

Official xAI docs:

- https://docs.x.ai/build/overview.md
- https://docs.x.ai/build/cli/headless-scripting.md
- https://docs.x.ai/build/cli/reference.md
- https://docs.x.ai/build/settings.md
- https://docs.x.ai/build/settings/reference.md

Local checks:

```sh
command -v grok
grok --help
grok version
grok -p "Reply with exactly GROK_OK and no other text." --output-format streaming-json
grok -p "Reply with exactly GROK_JSON_OK and no other text." --output-format json
```

Local version:

```text
grok 0.2.93 (f00f96316d4b) [stable]
```

Orchestrator code reviewed:

- `packages/core/src/runtime/runtimes.ts`
- `packages/core/src/runtime/types.ts`
- `packages/core/src/runtime/launch-plan.ts`
- `packages/core/src/tasks/output-adapters.ts`
- `packages/core/src/tasks/executors/protocol/*`
- `test/runtime.test.ts`
- `test/tasks.test.ts`
- `test/cli-contract.test.ts`

## Grok Capabilities Relevant To Orchestrator

Grok supports headless process mode:

```sh
grok -p "Explain this codebase"
grok -p "Explain the architecture" --output-format streaming-json
```

Useful flags:

- `-p, --single <PROMPT>`: one prompt and exit
- `-m, --model <MODEL>`: select model
- `-s, --session-id <ID>`: create named headless session
- `-r, --resume <ID>`: resume an existing session
- `-c, --continue`: continue most recent session in current directory
- `--cwd <PATH>`: set working directory
- `--output-format plain|json|streaming-json`
- `--always-approve`: auto-approve tool executions
- `--no-auto-update`: suppress background update checks in automation
- `--no-subagents`: disable Grok's own subagents
- `--disable-web-search`: disable web search

Grok stores headless sessions in `~/.grok/sessions`.

Grok also supports ACP:

```sh
grok agent stdio
```

The docs show JSON-RPC over stdio with:

- `initialize`
- `authenticate`
- `session/new`
- `session/prompt`
- `session/update` notifications

Authentication can use cached local login or `XAI_API_KEY`.

## Local Output Shape

`--output-format json` produced one final JSON object:

```json
{
  "text": "GROK_JSON_OK",
  "stopReason": "EndTurn",
  "sessionId": "019f47f0-60b3-7d40-9077-a27ef986bf10",
  "requestId": "4528c4e3-39ec-4f16-853a-5c5a503e73d3",
  "thought": "..."
}
```

`--output-format streaming-json` produced newline-delimited events:

```json
{"type":"thought","data":"The"}
{"type":"text","data":"GRO"}
{"type":"text","data":"K"}
{"type":"text","data":"_"}
{"type":"text","data":"OK"}
{"type":"end","stopReason":"EndTurn","sessionId":"019f47f0-12d5-72e3-b856-50fc1cdd2ea0","requestId":"db132f55-0efd-46ee-80d5-32bd24c79bcd"}
```

Important finding: streaming JSON emits text as chunks. Orchestrator's generic
JSONL adapter can parse line events, but today it does not accumulate chunked
text for arbitrary runtimes. If we use streaming JSON, Grok needs a small
runtime-specific normalizer/result accumulator.

## Fit With Current Orchestrator

The simplest process runtime shape is:

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
    defaultOutputMode: "json",
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
};
```

Two decisions are required:

1. Default output mode.
2. Whether first-class Grok includes ACP now or later.

## Recommended First Slice

Add Grok as a normal process runtime first.

Use `--output-format streaming-json` as the default only if we add a Grok
normalizer that accumulates `text` chunks and treats `end` as final. Otherwise
use `--output-format json` first, because it gives a complete final answer and
session id in one object.

The better first-class implementation is:

1. Add `grok` to `BUILT_IN_RUNTIME_IDS`.
2. Add `GROK_RUNTIME` to `BUILT_IN_AGENT_RUNTIMES`.
3. Add Grok plan tests:
   - default launch args;
   - model flag;
   - text/json/streaming output modes;
   - resume args.
4. Add output adapter support:
   - `normalizeGrokEvent`;
   - `extractGrokResultText`;
   - provider metadata from `end.sessionId`;
   - provider metadata from JSON mode if we keep JSON as an output mode.
5. Add task fixture tests:
   - streaming JSON chunks produce final output `GROK_OK`;
   - `end.sessionId` persists as provider metadata;
   - error events become `runtime.error` if Grok emits them.
6. Add CLI/help/skill docs so agents can choose `grok`.
7. Add skipped live smoke:

```sh
RUN_GROK_SMOKE=1 node --experimental-strip-types --test test/grok-smoke.test.ts
```

No provider-limit reader is needed in this slice.

## Resume Support

Grok supports `--resume <ID>` and emits `sessionId` in both JSON and streaming
JSON output.

To make Orchestrator `resume` work:

- extend `TaskProviderMetadata` to include `provider: "grok"`;
- store `sessionId` from Grok output;
- add `buildGrokResumePlan`;
- extend resume error hints to include Grok;
- add tests like Claude Code/Copilot resume tests.

Likely resume args:

```sh
grok --no-auto-update --resume <session-id> --output-format streaming-json -p "<next task>"
```

or JSON mode:

```sh
grok --no-auto-update --resume <session-id> --output-format json -p "<next task>"
```

Confirm exact arg order in implementation with a smoke test.

## ACP Path

ACP is real and documented, but it is a larger implementation than process
runtime support.

What ACP would unlock:

- long-lived process integration;
- direct session creation;
- structured `session/update` chunks;
- cleaner app/IDE-style embedding.

What ACP would require:

- a generic ACP JSON-RPC client or a Grok-specific protocol executor;
- initialization/authentication flow;
- session lifecycle storage;
- prompt/update collection;
- interrupt/cancel semantics research;
- mapping ACP updates into Orchestrator task events;
- deciding whether this is a persistent session runtime like `codex-app-server`
  or a one-turn protocol runtime.

This should not block process runtime support.

## Open Questions

- Should `--always-approve` be part of the default runtime args? It improves
  unattended background work, but changes safety. Existing Copilot integration
  uses a no-ask/yolo mode; Grok should be decided deliberately.
- Should `--no-subagents` be default? Since Orchestrator is already the
  multi-agent controller, disabling Grok's internal subagents may make behavior
  easier to reason about. But it may also reduce Grok Build's native capability.
- Should default output mode be `json` first for reliability, or
  `streaming-json` first for better observability? If we add the Grok normalizer
  immediately, `streaming-json` is preferable.
- Does Grok emit token usage in any headless event? The local probe did not show
  usage. Do not promise token display until proven.
- Does Grok emit stable error events in streaming JSON? Need a fixture or live
  failure smoke.

## Recommendation

Support Grok in two phases:

1. First-class process runtime:
   - launch;
   - model selection;
   - structured output;
   - resume;
   - normalized events;
   - live smoke.
2. Optional ACP runtime later, only if we want persistent protocol sessions
   similar to `codex-app-server`.

Do not start with ACP. Grok's documented `-p` headless mode already gives us
the same basic shape as Claude Code, Codex, and Copilot. ACP is powerful, but it
is a separate protocol-runtime project.
