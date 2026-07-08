# 0059. Add GitHub Copilot CLI as a Process Runtime

Date: 2026-07-07

## Status

Accepted

## Context

Orchestrator can already manage headless process runtimes such as Claude Code
and Codex. GitHub Copilot CLI now has an official programmatic mode through
`copilot -p`, plus JSONL output, model selection, session resume, custom Copilot
agents, and permission flags. Local probing confirmed that `copilot -p` works,
that JSONL output includes a `sessionId`, and that `copilot --resume
<session-id> -p` can continue a prior session.

Copilot CLI also exposes ACP through `copilot --acp --stdio`, but ACP is public
preview and uses a different protocol shape than our Codex app-server adapter.
Starting there would add more moving parts before basic Copilot orchestration is
proven.

## Decision

Add `copilot` as a first-class Orchestrator process runtime.

The runtime will use Copilot CLI's programmatic prompt mode:

```sh
copilot --no-ask-user --yolo --output-format json --stream off -p "<task>"
```

The runtime will support launch, background management, model selection, JSONL
event capture, normalized final output, stored Copilot `sessionId`, and
`orchestrator resume` through that stored session id.

The built-in runtime will be autonomous by default because Orchestrator launches
background agents. A Copilot task that waits for interactive approval is not a
good managed background task. This must be documented plainly.

Do not implement ACP in this decision. If we later want persistent Copilot
sessions, live steering, or a protocol-level client, add that as a separate
runtime such as `copilot-acp`.

## Consequences

Users and agents will be able to run Copilot through the same Orchestrator
surfaces they already use for Claude Code and Codex:

```sh
orchestrator launch copilot --name "review api" --model claude-sonnet-5 \
  "Review the API package."
orchestrator resume <task-id> "Continue from the prior result."
```

Implementation must add the built-in runtime id/config, Copilot JSONL
normalization, Copilot provider metadata extraction, Copilot resume planning,
tests, docs, help text, and skill guidance.

Copilot usage data will not be identical to Claude or Codex. We will map real
token fields that Copilot emits, such as output tokens. Non-token fields such
as premium requests and duration data stay as event/provider details, not task
token counts. We will only store `totalTokens` when Copilot reports it or when
Orchestrator can compute it from real token components through the shared usage
contract.

Permission behavior becomes a visible product choice. The built-in `copilot`
runtime will be useful and autonomous, while stricter permission profiles can be
handled later through custom runtime config, a future provider-args feature, or
a separate conservative runtime profile.
