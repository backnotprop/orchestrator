# Research Spike: GitHub Copilot CLI as a Supported Runtime

Date: 2026-07-07

## Question

What would it take to support GitHub Copilot CLI as a first-class Orchestrator
agent runtime?

## Short Answer

Add Copilot CLI first as a normal process runtime using `copilot -p`.

That is the smallest useful path. It matches Orchestrator's current Claude Code
and Codex process-runtime model: start a headless process, pass a prompt, capture
stdout/stderr, normalize events, store provider metadata, and let Orchestrator
manage the task.

Add ACP later as a separate protocol runtime only if we want persistent Copilot
sessions, live steering, or richer client control. ACP is public preview and is
not the same protocol shape as our Codex app-server adapter.

## Sources Checked

- GitHub Docs: Copilot CLI getting started
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started
- GitHub Docs: Copilot CLI best practices
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices
- GitHub Docs: configure Copilot CLI
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli
- GitHub Docs: using Copilot CLI
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview
- GitHub Docs: automating Copilot CLI
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/quickstart
- GitHub Docs: running Copilot CLI programmatically
  - https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically
- GitHub Docs: Copilot CLI programmatic reference
  - https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- GitHub Docs: Copilot CLI command reference
  - https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- GitHub Docs: Copilot CLI ACP server
  - https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server

## Local Probe

Installed CLI:

```text
/Users/ramos/.local/state/fnm_multishells/41050_1782777760606/bin/copilot
GitHub Copilot CLI 1.0.68.
```

Plain headless prompt worked:

```sh
copilot -p 'Reply with exactly: hello from copilot' -s --no-ask-user
```

Result:

```text
hello from copilot
```

Structured JSONL output worked:

```sh
copilot -p 'Reply with exactly: json hello' \
  --no-ask-user \
  --output-format json \
  --stream off
```

Observed event types:

- `session.mcp_server_status_changed`
- `session.mcp_servers_loaded`
- `session.skills_loaded`
- `session.info`
- `session.tools_updated`
- `user.message`
- `assistant.turn_start`
- `assistant.message_start`
- `assistant.message_delta`
- `assistant.message`
- `assistant.turn_end`
- `assistant.idle`
- `result`

Useful fields:

- `assistant.message.data.content`: final assistant text.
- `assistant.message.data.model`: model name.
- `assistant.message.data.outputTokens`: output token count.
- `result.sessionId`: Copilot session id.
- `result.exitCode`: process result.
- `result.usage.premiumRequests`: GitHub premium request count.
- `result.usage.totalApiDurationMs`: provider request duration.
- `result.usage.sessionDurationMs`: session duration.

Resume worked:

```sh
copilot --resume <session-id> -p 'Reply with exactly: resumed copilot answer' \
  -s --no-ask-user
```

Result:

```text
resumed copilot answer
```

## Copilot Surfaces That Matter

### Process Mode

Copilot CLI officially supports programmatic one-shot use:

```sh
copilot -p "Explain this file: ./complex.ts"
```

Useful options:

- `-p`, `--prompt`: run a prompt and exit.
- `-s`, `--silent`: output only the answer.
- `--output-format json`: JSONL, one event per line.
- `--stream on|off`: control streaming.
- `--model <model>`: choose model.
- `--agent <agent>`: choose a Copilot custom agent.
- `--resume <session-id>`: resume a previous session.
- `--session-id <id>`: set or resume a session id.
- `--no-ask-user`: prevent the agent from asking the user questions.
- `--allow-tool`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`,
  `--allow-all`, `--yolo`: permission controls.

This maps directly to Orchestrator's process runtime model.

### ACP Mode

Copilot CLI can also run as an Agent Client Protocol server:

```sh
copilot --acp --stdio
copilot --acp --port 3000
```

The docs call ACP public preview. ACP is useful for IDEs, custom frontends,
automation, and multi-agent systems. It is the right direction for persistent
sessions and live client control, but it should be treated as a separate adapter.

## Fit With Current Orchestrator Code

Current runtime model:

- Built-ins live in `packages/core/src/runtime/runtimes.ts`.
- Runtime ids live in `packages/core/src/runtime/types.ts`.
- Launch plans are built in `packages/core/src/runtime/launch-plan.ts`.
- Process execution is already generic.
- JSONL event normalization lives in
  `packages/core/src/tasks/output-adapters.ts`.
- CLI launch already supports runtime, model, output mode, wait/background, and
  batch manifests.
- Resume already exists for Codex, Codex app-server, and Claude Code.

The minimum built-in runtime is straightforward:

```ts
id: "copilot"
displayName: "GitHub Copilot CLI"
detect.command: "copilot"
launch.executable: "copilot"
launch.baseArgs: ["-p", "--no-ask-user"]
launch.prompt: { kind: "argv", position: "last" }
launch.modelFlag: "--model"
outputModes:
  text:
    extraArgs: ["-s"]
    output: stdout_text
  jsonl:
    extraArgs: ["--output-format", "json"]
    output: jsonl_events finalEvent: "result"
resume:
  supported: true
```

But the polished version needs Copilot-specific normalization.

## Needed Code Changes

### 1. Add Built-In Runtime Id

Add `copilot` to `BUILT_IN_RUNTIME_IDS` and `BUILT_IN_AGENT_RUNTIMES`.

Recommended id:

```text
copilot
```

Reason: it matches the executable and gives the clean user command:

```sh
orchestrator launch copilot --name "review api" "Review the API package."
```

### 2. Add Copilot Runtime Config

Add a `COPILOT_RUNTIME` in `packages/core/src/runtime/runtimes.ts`.

Recommended defaults:

- `defaultOutputMode: "jsonl"`
- `handlesOwnAuth: true`
- `supportsStreaming: true`
- `supportsStructuredEvents: true`
- `supportsResume: true`
- `supportsRunningSteer: false`
- `supportsPersistentSession: false`
- `interrupt: "process_group"`
- timeout similar to Claude/Codex.

Do not add ACP under this runtime. Keep ACP separate later.

### 3. Normalize Copilot JSONL

Current generic JSONL support is not enough for a good Copilot runtime because
Copilot's final `result` event contains status/session/usage, not the final
answer text. The answer is in `assistant.message.data.content`.

Add Copilot handling in `output-adapters.ts`:

- Extract final result text from the latest `assistant.message.data.content`.
- Append normalized `agent.message`, `agent.result`, `runtime.error`,
  `agent.usage`, and session events.
- Extract provider metadata from `result.sessionId`.
- Extract output tokens from `assistant.message.data.outputTokens`.
- Extract premium request/session duration data from `result.usage`.

### 4. Extend Resume Planning

Orchestrator's task provider metadata already has a generic `provider?: string`
and `sessionId?: string`, but `AgentLaunchPlan.resume.provider` is currently
typed as `"codex" | "claude-code"`.

To make Copilot resume first-class:

- widen `AgentLaunchPlan.resume.provider` to include `"copilot"`;
- add `buildCopilotResumePlan`;
- emit args like:

```sh
copilot --resume <session-id> -p "<next task>" --output-format json
```

Resume should require stored `provider.sessionId`.

### 5. Add Tests

Use fake runtime scripts the same way existing tests do for Claude/Codex:

- launch `copilot` text mode and read final text;
- launch `copilot` JSONL mode and normalize final answer;
- store provider metadata from `result.sessionId`;
- resume a prior Copilot task using the stored session id;
- extract token/usage data when present;
- handle nonzero `result.exitCode` as failure;
- validate help/doctor output includes the new runtime.

### 6. Docs and Skill Updates

Update:

- `README.md`
- `skills/orchestrator/SKILL.md`
- `packages/cli/src/commands/help.ts`
- likely one focused doc, e.g. `doc/copilot.md`

Human guidance should be simple:

- Use `copilot` for GitHub Copilot CLI-backed headless work.
- Use `--model` to pick a Copilot model.
- Use `resume` when a prior Copilot task has a stored session id.
- For full autonomous file edits or shell work, Copilot needs appropriate
  permissions. Orchestrator should not hide that.

## Permission Problem

This is the main product design point.

Copilot CLI is permission-heavy by design. For non-interactive coding tasks, the
docs point to flags such as:

```sh
--allow-tool='shell(npm:*), write'
--allow-all
--yolo
--no-ask-user
```

Orchestrator currently does not have a general way to pass arbitrary provider
flags through `launch`. It supports model/output/timeout/session, but not:

```sh
orchestrator launch copilot --allow-tool ...
```

Options:

1. Start conservative:
   - built-in `copilot` uses `--no-ask-user`;
   - users configure a custom Copilot runtime if they want stronger permissions;
   - good for questions/research, weaker for real autonomous coding.

2. Start useful:
   - built-in `copilot` includes `--allow-all`;
   - it behaves like a real delegated coding agent;
   - higher risk and should be explicit in docs.

3. Add runtime args support:
   - let users pass provider-specific flags safely through Orchestrator;
   - more work, but best long-term shape.

Recommendation: do not block the first Copilot runtime on a general provider-args
system. Add a built-in with reasonable defaults, then decide if the product wants
`copilot` to be conservative or autonomous.

For Orchestrator's actual use case, autonomous is probably the right default,
but it should be a conscious decision.

## ACP Adapter Later

ACP should not be squeezed into the process runtime.

If we support ACP, it should be a separate runtime, probably:

```text
copilot-acp
```

It would need:

- an ACP client dependency or small ACP transport layer;
- session creation;
- prompt request handling;
- permission callbacks;
- session updates mapped to Orchestrator events;
- provider session ids stored on tasks;
- interrupt/stop behavior mapped through ACP;
- fake ACP server tests.

This is similar in product role to `codex-app-server`, but not the same
implementation. Codex app-server uses its own JSON-RPC protocol. Copilot ACP is
NDJSON through Agent Client Protocol and should get its own adapter.

## Risks

- Permission defaults can make the runtime either too weak or too permissive.
- JSONL output includes a lot of session noise unless normalized.
- Copilot loads user/project config, skills, MCP servers, and instructions by
  default. That is expected Copilot behavior, but can make tests and output noisy.
- `--output-format json` is JSONL; treating it as a single JSON object would be
  wrong.
- ACP is public preview and can change.
- Resume works locally, but task records need first-class Copilot provider
  metadata to make it reliable inside Orchestrator.
- Token reporting will not be identical to Claude/Codex. Copilot surfaced output
  tokens and premium requests in the probe, not a full provider token breakdown.

## Recommended Slices

### Slice 1: Built-In Process Runtime

Add `copilot` as a built-in process runtime using `copilot -p`.

Outcome:

- `orchestrator launch copilot "..."` works.
- text mode works.
- JSONL mode captures raw events.
- doctor/help/list/ps include Copilot.
- no ACP yet.

### Slice 2: JSONL Normalization and Resume

Make Copilot feel first-class.

Outcome:

- `read` returns the assistant answer from JSONL mode.
- `events --agent-only` is readable.
- `ps` shows useful last message and usage.
- `resume` works from stored `sessionId`.

### Slice 3: Permission UX

Decide how Orchestrator exposes Copilot permissions.

Outcome:

- either built-in Copilot is intentionally autonomous;
- or docs show custom runtime configuration for autonomous Copilot;
- or Orchestrator gets a provider-args feature.

### Slice 4: ACP Runtime

Only after process mode is solid.

Outcome:

- persistent Copilot sessions through ACP;
- live updates through Orchestrator events;
- future steering/control path.

## Recommendation

Implement Copilot support as a first-class process runtime first.

Do not start with ACP. ACP is promising, but it is a larger adapter with more
moving parts and preview stability risk. The process runtime gives us a useful
official Copilot integration quickly, with local auth, model selection, JSONL
events, usage, and resume.

The likely good product command is:

```sh
orchestrator launch copilot --name "review api" --model claude-sonnet-5 \
  "Review the API package and report the highest-risk issue."
```

Then:

```sh
orchestrator resume <task-id> "Continue and propose a fix."
```

That fits Orchestrator's current model cleanly.
