# Synthesis: Grok as a First-Class Harness

Date: 2026-07-09

## Summary

Grok Build should be added to Orchestrator as a first-class process runtime
first.

The useful first version is:

```sh
orchestrator launch grok --name "review api" --model grok-code-fast-1 \
  "Review the API package."
```

Under the hood, Orchestrator should run Grok through its headless prompt mode:

```sh
grok --no-auto-update --output-format streaming-json -p "<task>"
```

This fits the same first-class runtime shape as Claude Code, Codex process
mode, and GitHub Copilot CLI. Grok starts, runs a task, emits structured output,
and exits. Orchestrator stores the task, logs, normalized events, final result,
provider session id, and provider resume metadata.

## What We Learned

Grok has the process surface Orchestrator needs:

- `grok -p "<prompt>"` for headless one-shot work.
- `-m` / `--model` for model selection.
- `--output-format plain|json|streaming-json` for output modes.
- `--resume <session-id>` for provider resume.
- `--no-auto-update` for automation.
- local headless sessions under `~/.grok/sessions`.

Local probing showed two useful structured output shapes:

- `json` emits one final object with `text`, `sessionId`, `requestId`, and
  `thought`.
- `streaming-json` emits JSON lines with chunked `thought` and `text` events,
  then an `end` event with `sessionId` and `requestId`.

The main implementation detail is output normalization. Grok streaming JSON
emits the answer as text chunks. The generic JSONL adapter can parse the lines,
but a first-class Grok runtime needs a small Grok normalizer and result
accumulator so `read`, `events --agent-only`, token display, and resume behave
like the other supported runtimes.

Grok also exposes ACP through:

```sh
grok agent stdio
```

That is a different protocol surface. It may become useful for persistent
sessions or richer control, but it is not needed for the first useful Grok
integration.

## Recommendation

Implement `grok` as a process runtime first.

Use `streaming-json` as the default output mode, but only with Grok-specific
normalization that accumulates `text` chunks into the task result and stores
`end.sessionId` as provider metadata. Keep `json` and `text` as explicit output
modes for diagnostics and provider-specific use.

Do not start with ACP. That would add a new protocol path before the simpler
process harness is proven.

The first implementation should support:

- launch
- wait/background task management
- model selection
- streaming JSON event capture
- normalized final answer
- stored Grok `sessionId`
- `orchestrator resume`
- opt-in live smoke testing

## Permission Decision

Do not put `--always-approve`, `--no-subagents`, or `--disable-web-search` in
the built-in default for the first spec.

Those flags are provider policy choices, not required runtime wiring. The
smallest first-class runtime should avoid changing Grok's permission, search,
or internal subagent behavior silently. If live smoke testing shows Grok cannot
complete normal background tasks without `--always-approve`, treat that as a
separate product decision before accepting the ADR.

## Required Orchestrator Changes

The codebase already has the right structure:

- built-in runtime registry in `packages/core/src/runtime/runtimes.ts`;
- runtime id list in `packages/core/src/runtime/types.ts`;
- process launch plan builder in `packages/core/src/runtime/launch-plan.ts`;
- process supervision and task state;
- JSONL output adapter in `packages/core/src/tasks/output-adapters.ts`;
- provider metadata and resume flow.

The missing pieces are:

- `grok` built-in runtime id/config;
- Grok-specific streaming JSON normalization;
- Grok result text accumulation from `text` chunks;
- Grok provider metadata extraction from `end.sessionId`;
- Grok resume launch-plan support;
- tests, docs, help text, and skill guidance.

## Current Unknowns

- Whether Grok reports token usage in CLI events. The local probe did not show
  usage fields.
- Whether Grok headless coding tasks can complete useful filesystem work
  without interactive approval. The first spec should not guess this by adding
  `--always-approve`.
- Whether ACP should eventually be `grok-acp` or a richer mode of `grok`.
  Defer this until process mode is useful.

## Slices

1. Add built-in `grok` runtime config.
2. Normalize Grok streaming JSON and store provider metadata.
3. Add Grok resume support.
4. Update docs, help, and Orchestrator skill guidance.
5. Add skipped live smoke test.
6. Revisit ACP only after process mode is stable.

## References

- `adr/research/SPIKE-grok-first-class-harness-20260709-103345.md`
- `adr/research/synthesis-github-copilot-cli-supported-runtime-20260707-173501.md`
- `adr/decisions/0059-add-github-copilot-cli-process-runtime-20260707-175401.md`
