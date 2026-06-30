# Research Spike: Resume Custom Process Runtimes

Date: 2026-06-29

Sub-agent: Carver

## Question

How could Orchestrator support resume for custom process runtimes and shell or
custom agents without hardcoding arbitrary agent behavior?

## Short Answer

Orchestrator has the right storage and executor seams, but resume is not
implemented. The right model is opt-in: a custom process runtime declares how
to resume, and the agent emits a normalized opaque session handle. Orchestrator
stores that handle and later starts a new task using the configured resume
template.

Shell should not get generic resume. At most it can rerun a command or use an
explicitly configured custom process agent that owns its own state.

## Evidence With File References

- Runtime types already model `supportsResume` and optional `resume.args`, but
  `AgentLaunchPlan` has no resume target or resume mode:
  [`types.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/types.ts:32),
  [`types.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/types.ts:68),
  [`types.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/types.ts:100).
- Built-ins set resume metadata inconsistently with behavior:
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:88),
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:177),
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:212).
- Custom config only accepts `adapter: "process"` and compiles every custom
  runtime with `resume: { supported: false }`:
  [`config.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/config.ts:293),
  [`config.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/config.ts:376).
- Launch-plan building always builds a fresh launch from prompt/model/output
  mode; no resume input is accepted:
  [`launch-plan.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/launch-plan.ts:24),
  [`launch-plan.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/launch-plan.ts:70).
- Task records can already store external IDs:
  [`types.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/types.ts:47),
  [`types.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/types.ts:126).
- The supervisor can update provider metadata durably, and Codex app-server
  already stores `threadId`/`turnId`:
  [`supervisor.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/supervisor.ts:212),
  [`codex-app-server.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/protocol/codex-app-server.ts:240).
- Process execution is one spawned process per task, finalized on process
  close:
  [`process.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/process.ts:97),
  [`process.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/executors/process.ts:226).
- Custom JSONL output can emit usage/events, but not durable provider metadata
  today:
  [`output-adapters.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/output-adapters.ts:143),
  [`output-adapters.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/tasks/output-adapters.ts:174).
- Shell is `sh -lc`, accepts shell command strings, and declares no structured
  events or resume:
  [`runtimes.ts`](/Users/ramos/oss-agents/pi-research/packages/core/src/runtime/runtimes.ts:197).
- Flue owns named durable sessions internally, with storage keys and recovery
  separate from Orchestrator:
  [`harness.ts`](/Users/ramos/oss-agents/flue/packages/runtime/src/harness.ts:68),
  [`session-identity.ts`](/Users/ramos/oss-agents/flue/packages/runtime/src/session-identity.ts:22),
  [`agent-coordinator.ts`](/Users/ramos/oss-agents/flue/packages/runtime/src/node/agent-coordinator.ts:29).

## Resume Model

Add a new command or tool action that creates a new Orchestrator task, not an
in-place mutation of the old task:

```sh
orchestrator resume <task-id|prefix> "<new prompt>"
```

The old task supplies runtime, cwd, model, and provider/session metadata. The
current runtime config supplies the resume template. The new task records
`resumedFromTaskId` and starts a fresh process/protocol turn.

For custom process agents, require both:

- Config declares resume support, for example a resume argv template using
  `{prompt}` and `{sessionId}`.
- The agent emits structured JSONL metadata, for example
  `{"type":"agent.session","sessionId":"..."}` or a stricter provider object.

No session handle, no resume.

## What Orchestrator Would Store

- Existing `provider.sessionId`, `remoteTaskId`, `threadId`, or a new
  `resumeHandle` if `sessionId` is too narrow.
- New resume linkage, for example
  `resume: { fromTaskId, rootTaskId, attempt }`.
- The new task's actual resume `launchPlan`.
- Normal task files: events, transcript, logs, result, usage.
- A normalized event such as `agent.resume.linked`.

## Risks

- Shell cannot be resumed generically.
- Re-running a command is not resume and may duplicate side effects.
- Custom agents may report session IDs late, never, or inconsistently.
- Config drift can make an old session handle unusable with a newer resume
  template.
- Provider metadata is currently not exposed in compact task JSON.
- Stale/orphaned process handling is intentionally conservative because PIDs
  can be reused.

## Recommendation

Implement custom resume as an opt-in process-agent contract:

1. Add public custom config `resume` with a small argv-template shape.
2. Add a generic JSONL metadata event that updates `task.provider`.
3. Add `resume` task linkage metadata.
4. Add `orchestrator resume` that creates a new task from stored provider
   metadata.
5. Keep `shell` as non-resumable; document rerun separately.

Do not add framework-specific Flue/Codex/Claude branches for custom agents. If
a framework can expose a headless command plus session handle, it fits the
process contract. If it needs remote async lifecycle, it belongs in the future
HTTP adapter.

## Unknowns

- Exact public JSONL metadata shape.
- Whether to add `resumeHandle` or reuse `sessionId`.
- Whether compact JSON should expose provider/resume metadata by default.
- How much config drift protection is needed.
- Whether built-in `codex`/`pi` resume flags should become real user-facing
  resume commands in the same slice.
