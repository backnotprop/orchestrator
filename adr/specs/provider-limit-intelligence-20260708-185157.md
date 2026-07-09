# Provider Limit Intelligence

Date: 2026-07-08

## Status

Draft spec.

## Intent

Give Orchestrator a first-class way to show provider limits before agents spend
work. This is different from task token usage. Task usage tells us what a
running or finished task consumed. Provider limits tell us how much room is left
on Codex, Copilot, Claude, or another provider account before we launch work.

The practical goal is simple: a human or agent should be able to run
`orchestrator limits` and see whether a provider is healthy, close to a reset,
or unavailable. Later, the parent agent can use the same data to choose where to
send work.

## Product Shape

Add a new CLI surface:

```sh
orchestrator limits
orchestrator limits --provider codex
orchestrator limits --provider copilot
orchestrator limits --provider claude
orchestrator limits --json
orchestrator limits --json --compact
```

Human output should be short:

```text
provider  account              status      primary        secondary      reset
codex     ramos@example.com    available   42% used       67% used       3h
copilot   backnotprop          available   18% used       -              12d
claude    unavailable          unavailable -              -              auth missing
```

JSON output should be stable enough for agents and scripts. Compact JSON should
return only the fields needed for routing decisions.

Do not make launches depend on this by default. Limits are information. A human
or agent can decide what to do with them.

## Relationship To Task Usage

Keep this separate from `TaskUsage`.

`TaskUsage` answers:

- how many tokens did this task use?
- is this usage live or final?
- did Claude, Codex, Copilot, or a custom agent report it?

Provider limits answer:

- which account is active?
- how much of the provider window is used?
- when does it reset?
- are credits or budget caps available?
- can we trust this number?

Do not write account quota, subscription limits, reset credits, or rate windows
into task records. They belong in provider-limit snapshots.

## Core Data Model

Add a core module:

```text
packages/core/src/provider-limits/
  index.ts
  types.ts
  readers.ts
  codex.ts
  copilot.ts
  claude.ts
```

Also export it from:

```text
packages/core/src/index.ts
packages/core/package.json      # ./provider-limits
```

Initial types:

```ts
type ProviderLimitProvider = "codex" | "copilot" | "claude" | (string & {});

type ProviderLimitStatus = "available" | "partial" | "unavailable";

type ProviderLimitConfidence = "exact" | "estimated" | "unknown";

type ProviderLimitSource =
  | "codex-app-server"
  | "codex-oauth"
  | "copilot-api"
  | "claude-oauth"
  | "claude-cli"
  | "manual"
  | (string & {});

type ProviderLimitWindow = {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  resetDescription?: string;
  limitDescription?: string;
};

type ProviderCreditsSnapshot = {
  remaining?: number;
  used?: number;
  limit?: number;
  resetsAt?: string;
  unit?: string;
};

type ProviderLimitAccount = {
  id?: string;
  email?: string;
  username?: string;
  organization?: string;
  plan?: string;
  loginMethod?: string;
};

type ProviderLimitSnapshot = {
  provider: ProviderLimitProvider;
  status: ProviderLimitStatus;
  source?: ProviderLimitSource;
  confidence: ProviderLimitConfidence;
  account?: ProviderLimitAccount;
  windows: ProviderLimitWindow[];
  credits?: ProviderCreditsSnapshot;
  updatedAt: string;
  staleAfter?: string;
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
};

type ProviderLimitsReport = {
  schemaVersion: 1;
  generatedAt: string;
  providers: ProviderLimitSnapshot[];
};
```

Rules:

- Use `available` only when we have usable limit data.
- Use `partial` when identity or some windows are available, but important data
  is missing.
- Use `unavailable` when auth, CLI, API, network, or parsing failed.
- Keep raw provider payloads out of public JSON by default.
- Redact secrets and tokens from every error.
- Each reader must have a timeout.
- Provider readers should return unavailable snapshots instead of throwing for
  normal auth or provider failures.

## Reader Interface

Use a small interface:

```ts
type ProviderLimitReaderInput = {
  provider: ProviderLimitProvider;
  workspaceRoot: string;
  orchestratorDir?: string;
  timeoutMs: number;
  now?: Date;
};

type ProviderLimitReader = {
  provider: ProviderLimitProvider;
  read(input: ProviderLimitReaderInput): Promise<ProviderLimitSnapshot>;
};
```

Add a coordinator:

```ts
readProviderLimits({
  providers?: ProviderLimitProvider[];
  workspaceRoot,
  orchestratorDir,
  timeoutMs,
}): Promise<ProviderLimitsReport>
```

The coordinator should run provider readers concurrently with bounded timeouts.
One failed provider must not fail the whole report.

## CLI Contract

Add:

```text
packages/cli/src/commands/limits.ts
packages/cli/src/parsing/limits.ts
```

Supported options:

```sh
orchestrator limits [--provider <codex|copilot|claude>] [--json [--compact]]
orchestrator limits [--timeout-ms <ms>]
```

Because the CLI supports leading common options for every public command, the
parser should also accept:

```sh
--workspace <path>
--orchestrator-dir <path>
--config <path>
```

`--workspace` gives the command the same project context as the rest of the CLI.
`--orchestrator-dir` lets tests and future cache/backend state use a custom
store. `--config` should be accepted for command consistency even if provider
limits do not need runtime config in the first slice.

Do not add `--refresh`, `--source`, or `--show-limits` in the first slice unless
implementation proves they are needed.

Human behavior:

- Show one row per provider.
- Show unavailable providers plainly.
- Prefer percentages and reset text over provider-specific terms.
- Do not print raw endpoint errors unless there is no better explanation.

Full JSON behavior:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-08T18:51:57.000Z",
  "providers": [
    {
      "provider": "codex",
      "status": "available",
      "source": "codex-app-server",
      "confidence": "exact",
      "account": { "email": "ramos@example.com", "plan": "pro" },
      "windows": [
        {
          "id": "primary",
          "label": "primary",
          "usedPercent": 42,
          "remainingPercent": 58,
          "resetDescription": "3h"
        }
      ],
      "updatedAt": "2026-07-08T18:51:57.000Z"
    }
  ]
}
```

Compact JSON behavior:

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "codex",
      "status": "available",
      "account": "ramos@example.com",
      "primaryUsedPercent": 42,
      "primaryReset": "3h"
    }
  ]
}
```

Add `limits` to `orchestrator help` and `help --json`.

## Parent-Agent Tool

Add the parent-agent tool only after the CLI output feels right:

```ts
get_provider_limits({
  providers?: Array<"codex" | "copilot" | "claude">
})
```

Tool result should mirror compact JSON by default, with enough detail for
routing:

- provider id;
- status;
- account label;
- primary/secondary used percentage;
- reset description;
- error message when unavailable.

The tool should not auto-route work. It only reports facts.

## Provider Plan

### Codex

Build Codex first.

Detailed implementation for the Codex app-server and OAuth reader slices lives
in:

- `adr/specs/codex-provider-limit-readers-20260708-201317.md`

Preferred source order:

1. Codex app-server RPC.
2. Codex OAuth API.
3. Unavailable snapshot.

Codex app-server RPC should reuse the existing managed Codex app-server
controller and JSON-RPC client:

```text
packages/core/src/tasks/executors/protocol/codex-app-server-controller.ts
```

It should call:

- `initialize`
- `account/rateLimits/read`
- `account/read`

The current code already has `ensureCodexAppServer`,
`connectCodexAppServer`, and `withCodexAppServerConnection`, plus a generic
`connection.request()` method. Prefer that path over adding another
app-server process wrapper. It must not start a task, thread, turn, or goal just
to read limits.

The RPC reader should map:

- account identity and plan into `account`;
- primary and secondary rate windows into `windows`;
- extra named windows into additional `windows`;
- credits or individual limits into `credits` when present.

Codex OAuth API is the fallback or second slice. It should read credentials from:

- `$CODEX_HOME/auth.json`
- `~/.codex/auth.json`

Then it should refresh tokens when needed and call the known Codex/ChatGPT usage
endpoints identified in the CodexBar spike:

- `GET https://chatgpt.com/backend-api/wham/usage`
- `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`

OAuth is useful because it may expose reset credits and usage details that RPC
does not. It is also more sensitive because it touches provider auth directly,
so errors must be redacted and tests must use fixtures.

Do not implement browser dashboard scraping for Codex in core.

### Copilot

Build Copilot second.

Preferred source order:

1. GitHub/Copilot API using an already-authenticated local token.
2. Unavailable snapshot.

The CodexBar research points to:

- `GET https://api.github.com/copilot_internal/user`

The reader should map premium interaction quota, chat quota, reset information,
and user identity into the normalized snapshot when the endpoint returns them.

Open question for implementation preflight:

- where should Orchestrator read the usable token from on a normal developer
  machine: GitHub CLI auth, Copilot CLI auth, environment token, or another
  local auth file?

This should be answered before implementation, but the shared snapshot shape
does not need to change.

Do not scrape GitHub billing pages in the first Copilot slice.

### Claude

Build Claude third.

Preferred source order:

1. Claude OAuth/API if a stable local credential source is available.
2. Claude CLI `/usage` PTY probe as an optional fallback.
3. Unavailable snapshot.

The CodexBar research points to:

- `GET https://api.anthropic.com/api/oauth/usage`
- optional Claude web API paths;
- CLI PTY fallback that runs `claude`, sends `/usage`, and parses the rendered
  panel.

For Orchestrator core, start with the least brittle cross-platform source we can
prove. Avoid macOS-only keychain, browser cookie import, and web dashboard
scraping as default behavior.

The CLI PTY fallback is allowed only if it is:

- clearly bounded by timeout;
- non-interactive after startup;
- safe when unauthenticated;
- tested with fixture output;
- marked with lower confidence if parsing is fragile.

Claude should return unavailable when no safe source exists. It should not block
Codex or Copilot limit reporting.

## Caching

Add short-lived cache after the first reader works, not before.

Suggested path:

```text
~/.orchestrator/provider-limits/{provider}.json
```

Rules:

- Cache only normalized snapshots.
- Never cache OAuth access tokens in Orchestrator.
- Use provider-reported reset times when present.
- Otherwise use a short TTL, likely 60 seconds.
- `orchestrator limits` may return stale cached data only if live refresh fails,
  and the JSON should mark it stale.

The first Codex slice can skip cache if the RPC/API call is fast and reliable in
tests.

## Testing

Use fake HTTP/RPC fixtures first.

Tests should cover:

- Codex RPC success;
- Codex RPC unavailable;
- Codex OAuth success with primary/secondary/additional windows;
- auth file missing;
- token refresh failure;
- provider timeout;
- redaction of tokens in errors;
- one provider failing while others succeed;
- human output;
- full JSON output;
- compact JSON output;
- help contract includes `limits`.

Copilot and Claude readers should get their own fixture suites when built.

Live provider tests must be opt-in:

```sh
RUN_CODEX_LIMITS_SMOKE=1
RUN_COPILOT_LIMITS_SMOKE=1
RUN_CLAUDE_LIMITS_SMOKE=1
```

Never run live provider-limit smoke tests by default.

## Slices

### Slice 1: Shared Limit Model And CLI Skeleton

Outcome:

- core provider-limit types;
- reader interface;
- coordinator;
- package exports for `@backnotprop/orchestrator-core/provider-limits`;
- `orchestrator limits`;
- JSON and compact JSON output;
- unavailable placeholder readers for Codex, Copilot, and Claude;
- help contract updated.

This proves the product surface without touching real credentials.

Expected code touch points:

- `packages/core/src/provider-limits/*`
- `packages/core/src/index.ts`
- `packages/core/package.json`
- `packages/cli/src/commands/limits.ts`
- `packages/cli/src/parsing/limits.ts`
- `packages/cli/src/cli.ts`
- `packages/cli/src/commands/help.ts`
- `test/cli-contract.test.ts`
- a focused provider-limits test file, likely `test/provider-limits.test.ts`

### Slice 2: Codex App-Server Limit Reader

Outcome:

- Codex reader calls app-server account/rate-limit RPC;
- maps account and rate windows;
- timeout and unavailable behavior tested;
- no threads, turns, goals, or tasks are started.

### Slice 3: Codex OAuth Limit Reader

Outcome:

- reads `$CODEX_HOME/auth.json` or `~/.codex/auth.json`;
- refreshes token when needed;
- calls Codex/ChatGPT usage endpoints;
- maps credits and reset credits when present;
- falls back cleanly when unavailable.

After Slice 3, Codex should be useful enough for real operator decisions.

### Slice 4: Parent-Agent Tool

Outcome:

- parent agents can call `get_provider_limits`;
- tool returns compact provider status;
- instructions teach agents to check limits before launching large batches or
  long Codex goals.

### Slice 5: Copilot Limit Reader

Outcome:

- discovers usable GitHub/Copilot auth source;
- calls Copilot usage endpoint;
- maps account, quota windows, and reset data;
- returns unavailable if auth source is missing or unsupported.

### Slice 6: Claude Limit Reader

Outcome:

- implements the least brittle Claude source proven during preflight;
- maps account and usage windows where possible;
- uses CLI PTY fallback only if it is reliable enough;
- returns unavailable instead of guessing.

### Slice 7: Optional Live View Integration

Outcome:

- maybe add `orchestrator ps --show-limits`;
- maybe show provider limit cards in the future TUI;
- no routing policy yet.

## Non-Goals

- Do not depend on CodexBar.
- Do not import CodexBar Swift code.
- Do not add provider auto-routing in this feature.
- Do not block launches by default based on limits.
- Do not scrape browser dashboards in the first release.
- Do not store provider secrets in Orchestrator.
- Do not merge account limits into task token usage.
- Do not try to normalize dollar cost across providers in this slice.

## Risks

- Provider APIs can change.
- Local auth formats can change.
- Different providers report different units and windows.
- Some users may have multiple accounts.
- Some sources may be unavailable in CI or remote machines.
- Claude is likely the hardest to make reliable cross-platform.
- If this becomes a policy engine too early, it will slow down the product.

The mitigation is to keep the first implementation factual and small:
`orchestrator limits` reports what it can prove, marks the rest unavailable, and
lets humans or agents decide what to do.

## References

- `adr/research/SPIKE-codexbar-provider-limit-intelligence-20260708-094729.md`
- `adr/specs/token-usage-contract-20260619-135212.md`
- `packages/core/src/tasks/usage.ts`
- `packages/core/src/tasks/types.ts`
- `packages/cli/src/commands/help.ts`
