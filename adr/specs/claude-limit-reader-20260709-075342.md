# Claude Limit Reader

Date: 2026-07-09

## Status

Draft spec.

## Intent

Make `orchestrator limits --provider claude` return real Claude provider limit
data when available, and useful Claude account status when limit windows are not
available.

This should finish the first provider-limit trio: Codex, Copilot, and Claude.
The goal is not billing analytics. The goal is a practical signal before a human
or agent sends large work to Claude.

## User Behavior

Human:

```sh
orchestrator limits --provider claude
```

Expected OAuth-backed shape:

```text
provider  account             status     primary   secondary  reset  reset credits
claude    max                 available  18% used  42% used   3h     -
```

Expected CLI-auth fallback shape:

```text
provider  account             status   primary  secondary  reset    reset credits
claude    ramos@example.com   partial  -        -          usage_unavailable -
```

Agent:

```sh
orchestrator limits --provider claude --json --compact
```

Expected compact shape when OAuth usage works:

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "claude",
      "status": "available",
      "account": "max",
      "primaryUsedPercent": 18,
      "primaryReset": "3h",
      "secondaryUsedPercent": 42,
      "secondaryReset": "4d"
    }
  ],
  "fullLimits": {
    "args": ["limits", "--json", "--workspace", "/repo", "--provider", "claude"]
  }
}
```

## Implementation Shape

Replace the placeholder in:

```text
packages/core/src/provider-limits/claude.ts
```

Add a mapper:

```text
packages/core/src/provider-limits/claude-mapping.ts
```

No parser or command output change should be required.

## Source Order

Use this order:

1. OAuth access token from environment.
2. Claude credentials file if present and valid.
3. `claude auth status --json` partial fallback.
4. Unavailable snapshot.

The reader should return the first `available` snapshot. If OAuth fails but CLI
auth status succeeds, return the CLI `partial` snapshot unless the OAuth failure
is more actionable, such as `scope_missing` or `auth_failed`.

## OAuth Token Resolution

Environment token names:

```text
CLAUDE_OAUTH_ACCESS_TOKEN
ORCHESTRATOR_CLAUDE_OAUTH_ACCESS_TOKEN
```

Optional scopes env:

```text
CLAUDE_OAUTH_SCOPES
```

Default scopes to `user:profile` when the token comes from environment.

Credentials file sources:

```text
~/.claude/.credentials.json
```

Do not treat `$CLAUDE_CONFIG_DIR/.credentials.json` as a credential source in
this slice. The CodexBar source only proves `~/.claude/.credentials.json` for
OAuth credentials. Tests can inject a home directory or exact credentials path.

Parse the known Claude Code OAuth shape:

```json
{
  "claudeAiOauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1780000000000,
    "scopes": ["user:profile"],
    "rateLimitTier": "default_claude_max_5x",
    "subscriptionType": "max"
  }
}
```

Rules:

- Use only `claudeAiOauth`.
- Treat `mcpOAuth`-only payloads as unusable for provider limits.
- Do not read macOS Keychain.
- Do not read browser cookies.
- Do not store tokens in Orchestrator.
- Do not print tokens.
- In the first implementation, do not refresh expired Claude credentials.
  Return `oauth_refresh_required` with a clear hint instead.

## OAuth HTTP Request

Endpoint:

```text
GET https://api.anthropic.com/api/oauth/usage
```

Headers:

```text
Authorization: Bearer <access_token>
Accept: application/json
Content-Type: application/json
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/2.1.0
```

Use bounded `fetch` with `AbortController`. Tests must inject the HTTP client.

Do not run `claude --version` inside the reader just to build the user agent.
The static fallback is good enough and avoids another subprocess.

## OAuth Mapping

Response fields:

- `five_hour` -> `windows[0]`, id `session`, label `Session`
- `seven_day` -> weekly window, id `weekly`, label `Week`
- `seven_day_oauth_apps` -> extra window, label `OAuth apps`
- `seven_day_sonnet` -> extra window, label `Sonnet week`
- `seven_day_opus` -> extra window, label `Opus week`
- `seven_day_routines`, `seven_day_claude_routines`, `claude_routines`,
  `routines`, `routine`, `seven_day_cowork`, `cowork` -> extra window, label
  `Daily Routines`
- `limits[]` -> scoped extra windows when entries include `percent` and
  `scope.model.display_name`
- `extra_usage` -> `credits` with unit `USD`

Window rules:

- Treat `utilization` and `percent` as percent used.
- Set `remainingPercent = 100 - usedPercent` when useful.
- Clamp percentages to 0-100.
- Parse `resets_at` / `resetsAt` ISO timestamps.
- Set `resetDescription` using the existing short human reset style used by
  other provider-limit mappers.
- If `five_hour` is absent, put `seven_day` first so compact output still has a
  primary value.

`extra_usage` rules:

- Use it only when `is_enabled === true`.
- Map `used_credits` and `monthly_limit` into `credits.used` and
  `credits.limit`.
- Convert minor currency units to major units, matching CodexBar's observation
  that Claude returns cents.
- Compute `credits.remaining` when possible.
- Use `currency` as `credits.unit`, defaulting to `USD`.

Status:

- `available` when at least one usable usage window or extra-usage credit limit
  exists.
- `partial` when CLI auth status gives account/plan but OAuth usage windows are
  unavailable.
- `unavailable` when no safe source returns useful information.

## CLI Auth Status Fallback

Run:

```sh
claude auth status --json
```

Use `execFile`, not shell. Bound runtime to a short timeout.

Map:

- `email` -> `account.email`
- `orgName` -> `account.organization`
- `subscriptionType` -> `account.plan`
- `authMethod` -> `account.loginMethod`

Return:

```ts
{
  provider: "claude",
  status: "partial",
  source: "claude-cli",
  confidence: "exact",
  account,
  windows: [],
  error: {
    code: "usage_unavailable",
    message: "Claude CLI auth is available, but no OAuth usage token was available."
  }
}
```

Do not use CLI auth status as proof of quota. It is identity only.

## Errors

Map common failures:

| Condition                           | Error code                  |
| ----------------------------------- | --------------------------- |
| no OAuth token/file and CLI missing | `auth_missing`              |
| credentials are MCP-only            | `oauth_credentials_missing` |
| expired file token                  | `oauth_refresh_required`    |
| missing `user:profile` scope        | `scope_missing`             |
| OAuth API 401/403                   | `auth_failed`               |
| OAuth API 429                       | `provider_rate_limited`     |
| timeout                             | `timeout`                   |
| invalid JSON                        | `invalid_provider_response` |
| no usable payload                   | `invalid_provider_response` |
| network/server failure              | `provider_unavailable`      |

All errors must pass through the shared redaction path.

## Tests

Add or extend `test/provider-limits.test.ts`:

- env token is used before file token;
- credentials file source is read when env token is absent;
- MCP-only credentials return `oauth_credentials_missing`;
- expired credentials return `oauth_refresh_required`;
- OAuth success maps session and weekly windows;
- OAuth success maps Sonnet/Opus/routines/scoped windows;
- OAuth success maps `extra_usage` into credits;
- 401/403 returns `auth_failed`;
- 403 mentioning `user:profile` returns `scope_missing`;
- 429 returns `provider_rate_limited`;
- malformed JSON returns `invalid_provider_response`;
- no OAuth token but `claude auth status --json` succeeds returns `partial`;
- no OAuth token and CLI auth status fails returns `auth_missing`;
- errors redact bearer tokens and token query values.

Add or extend `test/cli-limits.test.ts` only if CLI output expectations need to
change from `not_implemented` to the new no-auth behavior. The no-auth test env
must clear Claude-specific env vars and avoid any real `CLAUDE_CONFIG_DIR` so
local machine auth cannot leak into deterministic tests.

Add skipped live smoke:

```text
test/claude-limits-smoke.test.ts
```

Guard:

```sh
RUN_CLAUDE_LIMITS_SMOKE=1
```

Live smoke should accept either:

- `available` when a usable Claude OAuth token or credentials file exists; or
- `partial` when only `claude auth status --json` works.

Do not run live provider-limit smoke tests by default.

## Non-Goals

- Do not implement Keychain reads.
- Do not import browser cookies.
- Do not scrape Claude web dashboards.
- Do not automate interactive `claude /usage` in this slice.
- Do not refresh or rewrite Claude credentials in this slice.
- Do not add provider auto-routing.
- Do not block Claude launches based on limits.

## Implementation Notes

Keep the reader small and testable:

- inject `env`;
- inject `httpClient`;
- inject `authStatusCommand`;
- keep parsing/mapping pure;
- keep subprocess work behind a timeout;
- keep provider-specific logic in `packages/core/src/provider-limits`.

The CLI should remain a thin display layer over the shared provider-limit model.

## References

- `adr/research/SPIKE-claude-limit-reader-20260709-075342.md`
- `adr/research/synthesis-claude-limit-reader-20260709-075342.md`
- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
- `adr/specs/provider-limit-intelligence-20260708-185157.md`
- `adr/research/SPIKE-codexbar-provider-limit-intelligence-20260708-094729.md`
- `packages/core/src/provider-limits/claude.ts`
- `packages/core/src/provider-limits/copilot.ts`
- `packages/core/src/provider-limits/readers.ts`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthCredentialModels.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/docs/claude.md`
