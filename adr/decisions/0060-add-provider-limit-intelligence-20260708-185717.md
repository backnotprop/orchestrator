# 0060. Add Provider Limit Intelligence

Date: 2026-07-08

## Status

Accepted

## Context

Orchestrator already tracks task token usage. That tells us what an individual
agent task consumed when the runtime reports real usage. It does not tell us how
much room is left on a provider account before starting more work.

The CodexBar research showed that deep limit awareness is not exposed by one
generic CLI command. It comes from provider-specific readers: Codex app-server
RPC and OAuth APIs, Copilot/GitHub APIs, Claude OAuth/API or CLI usage probing,
and sometimes heavier web-dashboard paths. Orchestrator should learn from those
mechanics, but it should not depend on CodexBar or import its Swift/macOS
implementation.

Humans and agents need a simple way to see whether Codex, Copilot, or Claude is
healthy, close to reset, or unavailable before launching large batches,
long-running sessions, or Codex goals.

## Decision

Add provider limit intelligence as a first-class Orchestrator surface, separate
from task token usage.

The core will introduce a provider-limit model with snapshots for provider id,
status, account identity, source, confidence, rate windows, credits when
available, update time, stale state, and redacted errors. Provider readers must
return unavailable snapshots for normal auth, network, timeout, or parsing
failures instead of failing the whole report.

Add a CLI command:

```sh
orchestrator limits
orchestrator limits --provider codex
orchestrator limits --provider copilot
orchestrator limits --provider claude
orchestrator limits --json
orchestrator limits --json --compact
```

Build the providers in this order:

1. Codex first, using Codex app-server account/rate-limit RPC first and Codex
   OAuth API as the next source.
2. Copilot second, using a supported local GitHub/Copilot auth source and the
   Copilot usage API.
3. Claude third, using the least brittle cross-platform source we can prove,
   with CLI `/usage` probing only if it is reliable and bounded.

Add a parent-agent tool later, after the CLI contract is stable:

```ts
get_provider_limits({ providers?: string[] })
```

The tool will report facts for routing decisions. It will not auto-route work.

Do not merge account limits, subscription quota, credits, or reset windows into
`TaskUsage`. Do not block launches by default based on limits. Do not add web
dashboard scraping, provider auto-routing, or `ps --show-limits` in the first
implementation slice.

## Consequences

Orchestrator will gain a clear command for provider capacity:

```sh
orchestrator limits --json --compact
```

Agents can eventually check provider room before launching expensive work, but
launching remains explicit and user- or agent-directed.

The first implementation should be sliced:

1. shared model, reader interface, CLI skeleton, and unavailable placeholder
   readers for Codex, Copilot, and Claude;
2. Codex app-server limit reader;
3. Codex OAuth limit reader;
4. parent-agent tool;
5. Copilot limit reader;
6. Claude limit reader;
7. optional live-view integration later.

Provider APIs and local auth formats may change, so each reader must be tested
with fixtures, timeout cleanly, redact secrets, and degrade to unavailable
instead of guessing. Live provider tests must stay opt-in.

Reference specs and research:

- `adr/research/SPIKE-codexbar-provider-limit-intelligence-20260708-094729.md`
- `adr/specs/provider-limit-intelligence-20260708-185157.md`
- `adr/specs/token-usage-contract-20260619-135212.md`
