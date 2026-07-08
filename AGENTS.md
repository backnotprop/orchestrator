# Repository Guidelines

## Project Structure & Module Organization

- `packages/core`: reusable runtime, launch-plan, task-store, and supervisor code.
- `packages/cli`: the `orchestrator` command-line entrypoint.
- `test`: Node test suite, helpers, and JSONL fixtures.
- `doc`: user-facing docs and internal notes.
- `adr`: canonical Architecture Decision Records, research, and specs.
- `.orchestrator`: local task state; do not commit it. Often a testing artifact.

Keep runtime behavior in `packages/core` and terminal rendering or argv parsing in
`packages/cli`. ADRs capture durable architecture decisions.

## Documentation

Update docs when behavior changes. Use `README.md` for the short public entry
point, `doc/*.md` for user-facing setup and operations, `doc/internal/*.md` for
maintainer-facing explanations, and `adr/` for decisions, research, and specs.
Keep docs concrete and current with the CLI/API behavior.

## Product Direction

Orchestrator is a startup product, not an advanced enterprise platform. Ship the
simplest architecture that can become useful to humans and agents quickly. When
scoping or designing work, always ask: **am I over-engineering this?** If the
answer might be yes, say so plainly and propose the smaller launch-shaped
version. Warn about complexity before it becomes architecture.

Use concrete Orchestrator language. Avoid vague terms and jargon in docs, CLI
output, errors, and explanations.

## Build, Test, and Development Commands

Use Node `>=24` and pnpm `10.18.0`.

```sh
pnpm install
pnpm orchestrator --help
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm check
```

- `pnpm orchestrator --help`: run the local CLI.
- `pnpm test`: run `test/**/*.test.ts` with Node’s built-in test runner.
- `pnpm check`: run lint, format check, typecheck, and tests.

Provider smoke tests are opt-in. Use `RUN_CLAUDE_SMOKE=1`,
`RUN_CODEX_SMOKE=1`, or `RUN_COPILOT_SMOKE=1` only with credentials and CLIs
available.

## Coding Style & Naming Conventions

Code is TypeScript ESM. Use `.ts` imports with explicit extensions. Keep modules
small and colocate runtime-specific logic with the runtime layer. Prefer clear
names like `runtime`, `task`, `launchPlan`, and `registry`.

Formatting uses `oxfmt`; linting uses `oxlint`. Run `pnpm run format` only when
you intend to rewrite formatting.

## Testing Guidelines

Add tests near the behavior being changed:

- runtime/config/launch behavior: `test/runtime.test.ts`
- CLI behavior: `test/cli.test.ts`
- supervisor/task behavior: `test/tasks.test.ts`
- real CLI smoke tests: `test/claude-smoke.test.ts`, `test/codex-smoke.test.ts`

Name tests as behavior statements, for example
`test("config can disable built-in runtimes", ...)`.

## Commit & Pull Request Guidelines

Commit messages are short, imperative, and specific:
`Clarify README CLI positioning` or `Add core package install command`.

Before opening a PR, run `pnpm check`. PR descriptions should state the user
visible behavior, tests run, and docs or ADRs updated. Link related issues or
ADRs when the change affects architecture.

## Configuration & Agent Notes

Custom and disabled agents are configured through `~/.orchestrator/config.json`
or workspace config files. See `doc/custom-agents.md` and
`doc/disable-agents.md`.

The core API and CLI are agent-facing surfaces. Claude Code, Codex, and other
agents should be able to read the contract, call the API, recover from errors,
and manage agents without guessing. Always ask: **would this work if I were
using it?** Treat API clarity, examples, stable errors, and CLI ergonomics as
product work.
