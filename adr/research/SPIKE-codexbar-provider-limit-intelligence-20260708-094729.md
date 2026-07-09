# Spike: CodexBar Provider Limit Intelligence

Date: 2026-07-08

## Question

How does `/Users/ramos/oss/CodexBar` get deep usage-limit understanding, and
how could Orchestrator use similar data so an agent operator can make better
provider-routing decisions?

## Short Answer

CodexBar does not get this from one generic CLI command. It has a provider
limit system.

It combines:

- direct provider APIs;
- local agent/app credentials;
- provider app-server RPC where available;
- optional browser/web dashboard scraping;
- local session log scanning for historical token/cost totals;
- normalized display models for rate windows, credits, account identity, and
  confidence.

For Orchestrator, the right move is to reproduce the useful mechanics natively,
not depend on CodexBar. CodexBar is a macOS app and a useful reference
implementation, but Orchestrator needs this as a cross-platform core feature.

Do not mix account limits into task token usage. Orchestrator already has
task-level `TaskUsage`. Account/provider limits should be a separate provider
limits surface that the CLI, parent agent, and future TUI can read before
launching work.

## CodexBar Data Model

Core normalized shapes:

- `RateWindow`: percent used, window duration, reset time, reset text, optional
  regeneration metadata.
- `NamedRateWindow`: extra named limits such as model-specific limits or
  budget rows.
- `UsageSnapshot`: provider usage card. Holds primary/secondary/tertiary
  windows, extra windows, provider cost snapshots, reset credits, identity, and
  confidence.
- `CreditsSnapshot`: credit balance, credit events, and Codex-specific monthly
  credit limit.
- `ProviderPayload`: CLI JSON envelope with provider id, source, usage,
  credits, dashboard extras, status, and errors.

Key files:

- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/UsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/CreditsModels.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/CostUsageModels.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCLI/CLIPayloads.swift`

## CodexBar: Codex Limit Sources

CodexBar has several Codex paths.

### OAuth API

CodexBar reads Codex OAuth credentials from `~/.codex/auth.json` or
`$CODEX_HOME/auth.json`, refreshes tokens when needed, then calls:

- `GET https://chatgpt.com/backend-api/wham/usage`
- `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`

The usage response maps:

- `rate_limit.primary_window` to the session/short-window lane;
- `rate_limit.secondary_window` to the weekly lane;
- `additional_rate_limits[]` to named extra windows;
- `credits` and `individual_limit` to credit/limit snapshots;
- plan/account fields to provider identity.

Key files:

- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Codex/CodexProviderDescriptor.swift`

### Codex App-Server RPC

CodexBar starts:

```sh
codex -s read-only -a untrusted app-server
```

Then speaks JSON-RPC:

- `initialize`
- `account/rateLimits/read`
- `account/read`

This returns account identity, plan, primary/secondary rate windows, credits,
monthly/individual limit, and rate-limit status. Requests are serialized on the
single stdout stream and bounded by timeouts. On timeout, CodexBar terminates
the app-server process so refreshes do not hang forever.

Key implementation:

- `CodexRPCClient` in `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/UsageFetcher.swift`

### OpenAI Web Dashboard Extras

Optional and off by default. CodexBar can load:

```text
https://chatgpt.com/codex/settings/usage
```

through an off-screen `WKWebView`, using per-account WebKit stores and browser
cookie import. It extracts dashboard-only extras such as code review remaining,
usage breakdown, credit history, and credits purchase links.

This is powerful but heavier and more fragile than OAuth/RPC. It has battery
and privacy implications.

Key files:

- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/OpenAIWeb/*`
- `/Users/ramos/oss/CodexBar/docs/codex.md`

### Local Cost History

CodexBar scans local logs:

- `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- `~/.codex/archived_sessions/*.jsonl`
- `$CODEX_HOME/sessions/...`
- supported `~/.pi/agent/sessions/**/*.jsonl`

This is historical token/cost analysis, not live account-limit state.

Key files:

- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Vendored/CostUsage/*`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/PiSessionCostScanner.swift`

## CodexBar: Claude Sources

Claude limit understanding comes from:

- OAuth API: `GET https://api.anthropic.com/api/oauth/usage`
- Web API with `claude.ai` cookies:
  - organizations
  - organization usage
  - overage spend limit
- CLI PTY fallback:
  - run `claude`
  - send `/usage`
  - optionally send `/status`
  - parse the rendered terminal panel
- local log scanning for historical token/cost usage.

This is important for Orchestrator because `claude --help` does not expose a
simple account-limit command, but CodexBar still gets account limits through
other authenticated paths.

Key files:

- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeWeb/ClaudeWebAPIFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeStatusProbe.swift`
- `/Users/ramos/oss/CodexBar/docs/claude.md`

## CodexBar: Copilot Sources

Copilot uses:

- GitHub OAuth device-flow token;
- `GET https://api.github.com/copilot_internal/user`;
- optional GitHub web budget extras from
  `https://github.com/settings/billing/budgets`.

The internal usage endpoint maps premium interaction quota and chat quota into
rate windows. Budget extras are best-effort and require GitHub web cookies.

Key files:

- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Copilot/CopilotUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Copilot/CopilotBudgetWebFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Copilot/CopilotProviderDescriptor.swift`
- `/Users/ramos/oss/CodexBar/docs/copilot.md`

## Existing Orchestrator State

Orchestrator already models task usage:

```ts
type TaskUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  source?: "provider" | "runtime" | "estimated";
  scope?: "turn" | "task" | "session" | "account";
  final?: boolean;
  updatedAt: string;
};
```

That powers `ps`, compact JSON, task rows, and grouped token totals.

Important existing rule: Orchestrator does not fold account quota into task
usage. The token usage spec already says account quota, rate limits, and
credits are separate from task spend.

Key files:

- `packages/core/src/tasks/types.ts`
- `packages/core/src/tasks/usage.ts`
- `packages/core/src/tasks/operations.ts`
- `doc/live-agent-view.md`
- `doc/custom-agents.md`
- `adr/specs/token-usage-contract-20260619-135212.md`

## What Orchestrator Should Add

Add a provider limits surface separate from task usage.

Rough shape:

```ts
type ProviderLimitSnapshot = {
  provider: "codex" | "claude-code" | "copilot" | string;
  account?: {
    email?: string;
    organization?: string;
    plan?: string;
    loginMethod?: string;
  };
  source:
    | "codex-oauth"
    | "codex-app-server"
    | "claude-oauth"
    | "claude-web"
    | "claude-cli"
    | "copilot-api"
    | "manual"
    | string;
  confidence: "exact" | "estimated" | "unknown";
  windows: Array<{
    id: string;
    label: string;
    usedPercent?: number;
    remainingPercent?: number;
    resetsAt?: string;
    resetDescription?: string;
  }>;
  credits?: {
    remaining?: number;
    limit?: number;
    used?: number;
    resetsAt?: string;
  };
  updatedAt: string;
  error?: string;
};
```

Possible CLI/API:

```sh
orchestrator limits
orchestrator limits --provider codex
orchestrator limits --json --compact
orchestrator ps --show-limits
```

Parent-agent tool:

```ts
get_provider_limits({ providers?: string[] })
```

The parent can then decide:

- avoid launching a heavy Codex goal when weekly Codex is nearly exhausted;
- spread work across Claude/Codex/Copilot when one provider is close to reset;
- prefer cheaper or roomier providers for broad parallel work;
- warn the user before launching budget-risky batches.

## Implementation Options

### Option A: Build native Orchestrator limit readers

Recommended.

Implement the provider mechanics directly in TypeScript using the same broad
paths CodexBar proved:

- Codex first:
  - read `~/.codex/auth.json` or `$CODEX_HOME/auth.json`;
  - refresh OAuth tokens when needed;
  - call `https://chatgpt.com/backend-api/wham/usage`;
  - call `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`;
  - optionally use Codex app-server RPC `account/rateLimits/read` and
    `account/read` as a second source.
- Copilot second:
  - use GitHub/Copilot auth already available to the user;
  - call GitHub's Copilot usage endpoint if a supported token is available.
- Claude later:
  - start with the least brittle source we can support cross-platform;
  - avoid macOS-only web/keychain scraping as core behavior.

Pros:

- cross-platform;
- no external app dependency;
- Orchestrator owns the CLI/API shape;
- works for humans, agents, CI, and future service/TUI use;
- can be tested with fake HTTP/RPC fixtures.

Cons:

- more work than shelling out;
- provider APIs can change;
- auth refresh and credential handling must be implemented carefully.

### Option B: Shell out to CodexBar CLI

```sh
codexbar usage --provider all --format json --pretty
codexbar usage --provider codex --source oauth --format json --pretty
codexbar usage --provider codex --source cli --format json --pretty
codexbar usage --provider claude --format json --pretty
codexbar usage --provider copilot --format json --pretty
```

Not recommended for Orchestrator core.

This was useful as a research reference, but it should not be the product path.
CodexBar is a macOS app, its CLI/schema are not Orchestrator's contract, and a
global agent orchestration tool should not require a separate desktop app.

Cons:

- depends on an external binary;
- JSON schema is owned by CodexBar;
- some sources may prompt, touch browser cookies, or require platform-specific
  capabilities;
- Orchestrator needs timeouts, caching, redaction, and clear unavailable states.

### Option C: Import/extract CodexBar provider logic

Not recommended now.

CodexBar is Swift/macOS-heavy. Pulling that into a TypeScript Node runtime would
mean reimplementing provider auth, cookie import, WebKit scraping, keychain
policy, and many provider-specific parsers. That is too much surface area for
Orchestrator’s current product stage.

## Recommendation

Build native Orchestrator limit readers.

CodexBar should be treated as prior art for the mechanics, not a dependency.
The first release should expose:

- `orchestrator limits`;
- `orchestrator limits --provider codex`;
- `orchestrator limits --json --compact`;
- native Codex limit reading first, because the local auth file and backend
  API path are clear;
- native Copilot and Claude readers after the Codex path proves the model.

If a provider cannot be read, return a clear unavailable state. Do not block
agent launch unless the user or parent agent explicitly asks for limit-aware
routing. Keep task token usage and account limits separate.

## Implementation Notes

1. Add core limit types.
2. Add `ProviderLimitReader` interface.
3. Add a native `CodexLimitReader`.
4. Add fake HTTP/RPC fixtures for tests.
5. Add `orchestrator limits [--provider <id>] [--json --compact]`.
6. Add a parent tool only after the CLI shape feels right.
7. Add optional `ps --show-limits` summary later, not in the first slice.

The first slice should not include provider auto-routing. It should only expose
reliable limit facts. Routing policy should come after humans and agents can see
the facts.

## Risks

- Provider APIs and dashboard pages are unstable.
- Some data paths may require credentials, cookies, Keychain, or browser access.
- Capacity data has different freshness and confidence per provider.
- Percent windows, credits, reset credits, and spend limits are not the same
  unit.
- Account identity must be kept provider-scoped to avoid mixing accounts.
- This can become product-heavy if Orchestrator tries to own every provider
  integration itself.

## Research Boundaries

I did not run live CodexBar provider probes because they can touch real
credentials, Keychain, browser cookies, or provider network APIs. This spike is
based on local code and docs.
