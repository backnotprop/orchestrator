# Research Spike: Resume Claude Code Sessions

Date: 2026-06-29

Sub-agent: Carson

## Question

Can Orchestrator programmatically resume Claude Code sessions in headless mode,
and what metadata must it retain?

## Short Answer

Yes. Local Claude Code supports deterministic headless resume with:

```sh
claude -p --resume <session-id> --output-format stream-json --verbose "<next prompt>"
```

`--continue` also exists, but it resumes the most recent conversation for the
current directory, so it is not a good automation primitive. Orchestrator's
current `claude-code` runtime marks resume unsupported and does not promote
Claude's streamed `session_id` into `task.provider.sessionId`.

## Evidence With File References

- Claude declares `-p, --print` for non-interactive mode, plus `--continue`,
  `--resume`, `--fork-session`, `--resume-session-at`, and `--session-id`
  flags:
  [`main.tsx`](/Users/ramos/oss-agents/cc-open/main.tsx:968),
  [`main.tsx`](/Users/ramos/oss-agents/cc-open/main.tsx:976),
  [`main.tsx`](/Users/ramos/oss-agents/cc-open/main.tsx:988),
  [`main.tsx`](/Users/ramos/oss-agents/cc-open/main.tsx:1000).
- Headless mode passes resume options into `runHeadless`:
  [`main.tsx`](/Users/ramos/oss-agents/cc-open/main.tsx:2829).
- `runHeadless` accepts `continue`, `resume`, `resumeSessionAt`, and
  `forkSession`, then loads resumed messages through `loadInitialMessages`:
  [`cli/print.ts`](/Users/ramos/oss-agents/cc-open/cli/print.ts:455),
  [`cli/print.ts`](/Users/ramos/oss-agents/cc-open/cli/print.ts:680).
- In print mode, `--resume` must be a valid session id, JSONL file, or URL:
  [`cli/print.ts`](/Users/ramos/oss-agents/cc-open/cli/print.ts:5027),
  [`utils/sessionUrl.ts`](/Users/ramos/oss-agents/cc-open/utils/sessionUrl.ts:20).
- Resume loads the prior conversation and reuses the session id unless
  `--fork-session` is set:
  [`cli/print.ts`](/Users/ramos/oss-agents/cc-open/cli/print.ts:5074),
  [`cli/print.ts`](/Users/ramos/oss-agents/cc-open/cli/print.ts:5147).
- Claude transcript storage is under `getClaudeConfigHomeDir()/projects`;
  transcript paths are built from the active session id:
  [`utils/sessionStorage.ts`](/Users/ramos/oss-agents/cc-open/utils/sessionStorage.ts:198),
  [`utils/sessionStorage.ts`](/Users/ramos/oss-agents/cc-open/utils/sessionStorage.ts:202).
- Orchestrator's built-in Claude runtime is `claude -p` with stream JSON output,
  but says resume is unsupported:
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:17),
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:40),
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:48).
- Orchestrator already has `provider.sessionId` in task metadata:
  [`types.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/types.ts:47).
- The JSONL adapter sees Claude `session_id` on system/result events, but the
  process executor does not use `updateProvider` while running the adapter:
  [`output-adapters.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/output-adapters.ts:286),
  [`process.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/process.ts:90).

## Resume Model

A normal Orchestrator Claude task starts:

```sh
claude -p --output-format stream-json --verbose "<prompt>"
```

Claude emits a `system/init` event and later a `result` event containing
`session_id`. That session id points to Claude's own persisted transcript, not
Orchestrator's captured `transcript.jsonl`.

A resumed task should be a new Orchestrator task that runs:

```sh
claude -p --resume <session-id> --output-format stream-json --verbose "<next prompt>"
```

Claude Code reloads the prior transcript, switches the active process session
to that id, appends the new turn, and streams a normal result. Use
`--fork-session` only when Orchestrator wants to branch into a new Claude
session id.

## What Orchestrator Would Store

- `provider.sessionId`: Claude Code `session_id`.
- `provider.provider`: a stable value such as `claude-code`.
- Original `cwd`, already present on `AgentTaskRecord`.
- Original `model`, already present on `AgentTaskRecord`.
- Original launch environment and flags that affect Claude storage or
  permissions.
- Optional Claude transcript path or storage hint.
- Optional last Claude message UUID if Orchestrator wants to support
  `--resume-session-at`.
- A resume relationship between Orchestrator task ids.

## Risks

- `--continue` is nondeterministic for automation.
- Resume depends on Claude's external transcript store. If that store is
  deleted, moved, or uses a different config home, Orchestrator's task record
  alone is not enough.
- Concurrent resumes of the same Claude session could interleave or branch
  unexpectedly unless Orchestrator locks per Claude session id.
- `--session-id` is not a resume substitute.
- `--no-session-persistence` would make later resume impossible.
- Installed Claude Code behavior should be smoke-tested before relying on it.

## Recommendation

Mark `claude-code` resumable only after Orchestrator captures Claude
`session_id` into `task.provider.sessionId` and can build resume launch args
from a prior task. Prefer explicit `--resume <uuid>` over `--continue`. Create
a new Orchestrator task for each resumed turn and link it to the source task
instead of mutating the old task.

## Unknowns

- Exact installed Claude Code behavior was not smoke-tested.
- Whether Orchestrator should expose resume as a CLI command, core API option,
  or both.
- Whether Orchestrator needs first-class transcript-path storage, or whether
  `sessionId + cwd + env` is enough for the launch-shaped version.
