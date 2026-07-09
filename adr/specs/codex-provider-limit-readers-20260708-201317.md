# Codex Provider Limit Readers

Date: 2026-07-08

## Status

Draft spec.

## Intent

Implement real Codex data behind `orchestrator limits`.

Slice 1 created the provider-limit model, CLI command, and placeholder readers.
The next two slices should make Codex useful without changing the product
surface:

1. `codex-app-server` reader: call Codex app-server account/rate-limit RPCs.
2. `codex-oauth` reader: read Codex OAuth credentials and call Codex usage
   endpoints directly.

Both readers must produce the same `ProviderLimitSnapshot` shape. This keeps
the CLI simple for humans and agents:

```sh
orchestrator limits --provider codex
orchestrator limits --provider codex --json --compact
```

Do not start tasks, threads, turns, sessions, or goals to read limits. This is
account state, not agent work.

## Current State

Existing code:

```text
packages/core/src/provider-limits/
  types.ts
  readers.ts
  codex.ts        # placeholder
  copilot.ts      # placeholder
  claude.ts       # placeholder
packages/cli/src/commands/limits.ts
packages/cli/src/parsing/limits.ts
```

`createCodexLimitReader()` currently returns `not_implemented`. Replace that
placeholder with a composed Codex reader.

## Shared Codex Mapping

Add a shared mapper before either reader:

```text
packages/core/src/provider-limits/codex-mapping.ts
```

The mapper owns all Codex-specific response normalization:

- app-server camelCase fields: `usedPercent`, `windowDurationMins`, `resetsAt`
- OAuth snake_case fields: `used_percent`, `limit_window_seconds`, `reset_at`
- app-server `rateLimits` as the primary Codex snapshot, with
  `rateLimitsByLimitId` used for extra named windows
- account identity and plan mapping
- reset descriptions
- redacted provider errors

Rules:

- For app-server results, trust top-level `rateLimits` as the primary snapshot.
  Codex already chooses the `codex` limit id there when available.
- Add non-duplicate `rateLimitsByLimitId` entries as extra windows.
- Use `available` when at least one real rate window, credit value, or reset
  credit value exists.
- Use `partial` when account identity is known but limit data is incomplete.
- Use `unavailable` for auth, startup, network, timeout, unsupported method, or
  malformed response failures.
- Keep raw provider payloads out of public JSON.
- Never include OAuth tokens, refresh tokens, API keys, or full request bodies
  in errors.

Add one small model extension before these slices:

```ts
type ProviderResetCreditsSnapshot = {
  availableCount?: number;
  nextExpiresAt?: string;
};

type ProviderLimitSnapshot = {
  // existing fields...
  resetCredits?: ProviderResetCreditsSnapshot;
};
```

Do not overload `ProviderCreditsSnapshot` with reset credits. `credits` means
spend/usage credit balance. `resetCredits` means Codex reset-credit inventory.

## Slice 2: Codex App-Server Limit Reader

### Product Behavior

Use Codex app-server as the first Codex source because it is the official
protocol surface already used by Orchestrator.

Command:

```sh
orchestrator limits --provider codex
```

Expected healthy output:

```text
provider  account            status     primary   secondary  reset
codex     user@example.com   available  42% used  5% used    1h
```

Expected compact JSON shape:

```json
{
  "providers": [
    {
      "id": "codex",
      "status": "available",
      "source": "codex-app-server",
      "account": "user@example.com",
      "primaryUsedPercent": 42,
      "primaryReset": "1h"
    }
  ]
}
```

The exact compact shape may follow the existing Slice 1 formatter, but the
reader must supply enough data for it.

### Implementation Shape

Add:

```text
packages/core/src/provider-limits/codex-app-server.ts
```

Use the existing controller:

```text
packages/core/src/tasks/executors/protocol/codex-app-server-controller.ts
```

Read flow:

1. Connect with `withCodexAppServerConnection`.
2. Call `account/read` with `{ refreshToken: false }`.
3. If account is absent and auth is required, return unavailable with
   `auth_missing`.
4. Call `account/rateLimits/read`.
5. Map the result through `codex-mapping.ts`.
6. Return a `ProviderLimitSnapshot` with source `codex-app-server` and
   confidence `exact`.

Do not call:

- `thread/start`
- `turn/start`
- `turn/interrupt`
- goal methods
- any session/task executor

Timeouts should use the existing `ProviderLimitReaderInput.timeoutMs`; split it
conservatively across connect/account/limits calls rather than allowing one RPC
to consume the entire command.

### App-Server Errors

Return unavailable snapshots for normal provider failures:

| Condition                       | Error code                     |
| ------------------------------- | ------------------------------ |
| Codex CLI unavailable           | `codex_app_server_unavailable` |
| managed app-server cannot start | `codex_app_server_unavailable` |
| JSON-RPC method missing         | `unsupported_codex_app_server` |
| no logged-in OpenAI account     | `auth_missing`                 |
| RPC timeout                     | `timeout`                      |
| malformed RPC payload           | `invalid_provider_response`    |

The reader must not fail the whole limits report.

### Tests

Add core tests with a fake app-server source or fake connection. Do not require
real Codex credentials.

Required cases:

- account plus primary/secondary limits maps to an available snapshot.
- top-level `rateLimits` maps to the primary/secondary windows.
- non-duplicate `rateLimitsByLimitId` entries map to additional windows.
- `individualLimit` maps to `credits`.
- `rateLimitResetCredits.availableCount` maps to `resetCredits`.
- auth-required account maps to unavailable `auth_missing`.
- method-not-found maps to unavailable `unsupported_codex_app_server`.
- timeout maps to unavailable `timeout`.
- fake server asserts no thread, turn, session, or goal RPCs were called.

Add an opt-in live smoke later:

```sh
RUN_CODEX_LIMITS_SMOKE=1 pnpm test test/codex-limits-smoke.test.ts
```

The live smoke should verify only that the command returns a valid snapshot. It
must tolerate unavailable/auth-missing results.

## Slice 3: Codex OAuth Limit Reader

### Product Behavior

Use OAuth as the second Codex source. It should reproduce the mechanics we
confirmed from CodexBar research, but implemented natively in Orchestrator.

This is useful when app-server is unavailable, unsupported, or cannot expose all
account-limit data.

Source order:

1. Try app-server.
2. If app-server returns `available`, use it.
3. If app-server is unavailable or partial, try OAuth.
4. If OAuth returns `available`, use OAuth.
5. If both fail, return the most actionable unavailable snapshot. Prefer auth
   errors over generic startup errors.

Do not merge two successful snapshots in this slice. Keep the source of truth
obvious.

### Credential Store

Add:

```text
packages/core/src/provider-limits/codex-oauth.ts
packages/core/src/provider-limits/codex-auth-store.ts
```

Read credentials from:

1. `$CODEX_HOME/auth.json`
2. `~/.codex/auth.json`

Supported auth shape:

```json
{
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "id_token": "...",
    "account_id": "..."
  },
  "last_refresh": "2026-07-01T12:00:00Z"
}
```

Also support the legacy camelCase token keys:

```json
{
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "idToken": "...",
    "accountId": "..."
  }
}
```

If only `OPENAI_API_KEY` exists, OAuth usage is unavailable. API keys do not
give the same ChatGPT/Codex account window data.

### Refresh

If `last_refresh` is missing or older than the proven Codex refresh threshold,
refresh before calling usage:

```text
POST https://auth.openai.com/oauth/token
```

Body:

```json
{
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "<refresh token>",
  "scope": "openid profile email"
}
```

Refresh rules:

- Preserve unknown fields in `auth.json`.
- Write refreshed credentials atomically.
- Use file mode `0600` for staged and final credential writes.
- Do not print token values.
- If refresh fails because the token is expired, reused, revoked, or invalid,
  return unavailable with a clear re-login hint.

### HTTP Calls

Use native `fetch` with bounded timeout and injected URLs/transports in tests.

Usage endpoint:

```text
GET https://chatgpt.com/backend-api/wham/usage
```

Reset credit endpoint:

```text
GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
```

Headers:

```text
Authorization: Bearer <access token>
Accept: application/json
ChatGPT-Account-Id: <account_id>        # when available
```

For reset credits, also include the Codex-specific headers verified in the
CodexBar research:

```text
OpenAI-Beta: codex-1
originator: Codex Desktop
```

Usage is the primary call. Reset credits are additive. If usage succeeds and
reset credits fail with an unsupported or transient error, return the usage
snapshot without reset credits.

### OAuth Mapping

Map these usage fields:

- `plan_type` -> `account.plan`
- `rate_limit.primary_window` -> primary window
- `rate_limit.secondary_window` -> secondary window
- `additional_rate_limits[]` -> extra windows
- `credits.balance`, `credits.has_credits`, `credits.unlimited` -> credits
- `individual_limit` or equivalent spend-control object -> credits when present

Window mapping:

- `used_percent` -> `usedPercent`
- `100 - used_percent` -> `remainingPercent`
- `reset_at` Unix seconds -> ISO `resetsAt`
- `limit_window_seconds` -> `limitDescription`

Return source `codex-oauth` and confidence `exact` when a valid usage payload is
received.

### OAuth Errors

| Condition                                  | Error code                  |
| ------------------------------------------ | --------------------------- |
| no auth file                               | `auth_missing`              |
| auth file exists but has no OAuth tokens   | `oauth_tokens_missing`      |
| refresh required but refresh token missing | `oauth_refresh_missing`     |
| refresh token expired/revoked/reused       | `oauth_refresh_failed`      |
| usage endpoint returns 401/403             | `auth_failed`               |
| usage endpoint timeout                     | `timeout`                   |
| usage payload malformed                    | `invalid_provider_response` |
| network/server error                       | `provider_unavailable`      |

All error messages must be redacted.

### Tests

Required tests:

- `$CODEX_HOME/auth.json` wins over `~/.codex/auth.json`.
- snake_case token file parses.
- camelCase token file parses.
- API-key-only auth returns unavailable for OAuth usage.
- stale token refreshes and writes atomically while preserving unknown fields.
- expired/revoked refresh maps to a re-login hint.
- usage success maps primary and secondary windows.
- additional rate limits map to additional windows.
- credits and individual limit map to `credits`.
- reset credits map to `resetCredits`.
- reset-credit request failure does not fail a successful usage snapshot.
- app-server available prevents OAuth call.
- app-server unavailable falls back to OAuth.
- both sources unavailable returns the most actionable error.

## Public CLI Impact

The CLI command does not change. Existing users keep running:

```sh
orchestrator limits --provider codex
orchestrator limits --provider codex --json --compact
```

Human output should stay concise. If OAuth or app-server is unavailable, show a
plain reason and hint:

```text
codex  unavailable  auth missing  Run `codex` to log in.
```

Agents should rely on JSON:

```json
{
  "providers": [
    {
      "id": "codex",
      "status": "unavailable",
      "error": {
        "code": "auth_missing",
        "message": "Codex auth is missing.",
        "hint": "Run `codex` to log in."
      }
    }
  ]
}
```

## Implementation Order

1. Add `resetCredits` to the provider-limit type and formatters.
2. Add `codex-mapping.ts` with pure unit tests.
3. Add the app-server source and wire `createCodexLimitReader()` to use it.
4. Add app-server source tests with fake RPC responses.
5. Add OAuth credential parsing with temp-home tests.
6. Add OAuth refresh with atomic write tests.
7. Add OAuth usage/reset-credit HTTP tests with fake transport.
8. Compose app-server-first/OAuth-second source selection.
9. Add optional live smoke behind `RUN_CODEX_LIMITS_SMOKE=1`.
10. Update docs/help only if the visible command output changes.

## Non-Goals

- No launch blocking.
- No automatic provider routing.
- No browser scraping.
- No CodexBar dependency.
- No task, session, turn, or goal creation.
- No provider-limit data written into task records.
- No Copilot or Claude reader implementation in these slices.
- No TUI integration.

## Open Checks Before Implementation

- Confirm the current Codex CLI still exposes `account/read` and
  `account/rateLimits/read` in the installed app-server.
- Confirm whether the current Codex OAuth usage endpoint prefers
  `/backend-api/wham/usage` or `/backend-api/api/codex/usage` for the local auth
  mode. Keep this injectable in tests.
- Confirm whether reset credits are always available through app-server. If yes,
  OAuth reset-credit fetching remains a fallback detail, not a merge step.

## References

- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
- `adr/specs/provider-limit-intelligence-20260708-185157.md`
- `adr/research/SPIKE-codexbar-provider-limit-intelligence-20260708-094729.md`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthCredentials.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexTokenRefresher.swift`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/README.md`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/tests/suite/v2/rate_limits.rs`
