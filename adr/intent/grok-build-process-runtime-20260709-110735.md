# Intent: Grok Build Process Runtime

Date: 2026-07-09

Implement Grok Build as a first-class Orchestrator process runtime so humans
and agents can launch, observe, read, and resume Grok work through the same
task surfaces used for Claude Code, Codex, and Copilot.[^decision]

The product goal is to make `orchestrator launch grok ...` feel boring and
predictable. Grok should run through its documented headless prompt mode,
default to structured streaming output, store a final answer and provider
`sessionId`, and support `orchestrator resume` when the source task has real
Grok provider metadata.[^spec]

The implementation should stay launch-shaped. Add the built-in runtime config,
resume planning, provider metadata extraction, Grok-specific JSONL
normalization, and result accumulation for streaming `text` chunks. The task
result should only become final when Grok emits `end`; a stream with chunks but
no `end` should fail rather than returning a partial answer.

This should not add Grok ACP, persistent sessions, running messages, goals,
provider-limit readers, generic provider args, or default permission-changing
flags such as `--always-approve`. Those are separate decisions. The first slice
is the smallest useful Grok harness: process launch, normalized events, final
result, stored session id, resume, tests, docs, help text, skill guidance, and
an opt-in live smoke test.[^synthesis]

The preflight check found one implementation detail to handle carefully:
`packages/cli/src/commands/resume.ts` still has provider-specific branching for
session-backed resume metadata and active-session conflict checks. Grok should
make that code generic for session-id providers instead of adding another
one-off branch.

[^spike]: [Grok first-class harness spike](../research/SPIKE-grok-first-class-harness-20260709-103345.md)

[^synthesis]: [Synthesis: Grok as a first-class harness](../research/synthesis-grok-first-class-harness-20260709-104053.md)

[^spec]: [Spec: Grok first-class harness](../specs/grok-first-class-harness-20260709-104053.md)

[^decision]: [ADR 61: Add Grok Build as a process runtime](../decisions/0061-add-grok-build-process-runtime-20260709-105105.md)
