# Copilot Limit Reader

Date: 2026-07-08

## Status

Draft spec.

## Intent

Make `orchestrator limits --provider copilot` return real GitHub Copilot
capacity data.

Codex limits now work. Copilot is the next provider-limit slice. The goal is not
to build a billing system. The goal is to give humans and agents a simple signal
before they delegate work to Copilot.

## User Behavior

Human:

```sh
orchestrator limits --provider copilot
```

Expected shape:

```text
provider  account      status     primary   secondary  reset  reset credits
copilot   backnotprop  available  31% used  0% used    22d    -
```

Agent:

```sh
orchestrator limits --provider copilot --json --compact
```

Expected compact shape:

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "copilot",
      "status": "available",
      "account": "backnotprop",
      "primaryUsedPercent": 31,
      "primaryReset": "22d",
      "secondaryUsedPercent": 0,
      "secondaryReset": "22d"
    }
  ],
  "fullLimits": {
    "args": ["limits", "--json", "--workspace", "/repo", "--provider", "copilot"]
  }
}
```

## Implementation Shape

Replace the placeholder in:

```text
packages/core/src/provider-limits/copilot.ts
```

Add a mapper:

```text
packages/core/src/provider-limits/copilot-mapping.ts
```

The reader should:

1. Resolve a GitHub token.
2. Call the Copilot usage endpoint.
3. Map the response into `ProviderLimitSnapshot`.
4. Return unavailable snapshots for normal auth/API failures.

No CLI parser or command output change should be required.

## Token Resolution

Use this order:

1. `COPILOT_API_TOKEN`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `gh auth token --hostname github.com`

Implementation notes:

- Use `node:child_process` `execFile` or equivalent for `gh`.
- Bound `gh auth token` with a short timeout.
- Do not print token output.
- Do not store token output.
- Do not parse `~/.copilot/config.json`.
- Do not add OAuth device flow.

Return `auth_missing` when no usable token exists.

## HTTP Request

Endpoint:

```text
GET https://api.github.com/copilot_internal/user
```

Headers:

```text
Authorization: token <token>
Accept: application/json
Editor-Version: vscode/1.96.2
Editor-Plugin-Version: copilot-chat/0.26.7
User-Agent: GitHubCopilotChat/0.26.7
X-Github-Api-Version: 2025-04-01
```

Use bounded `fetch` with `AbortController`. Tests must inject the HTTP client.

## Mapping

Top-level fields:

- `login` -> `account.username`
- `copilot_plan` -> `account.plan`
- `source` -> `copilot-api`
- `confidence` -> `exact`
- `token_based_billing` can be retained only as internal mapping context for
  deciding `partial` vs `available`.

Quota fields:

- `quota_snapshots.premium_interactions` -> primary window, label `Premium`
- `quota_snapshots.chat` -> secondary window, label `Chat`
- `quota_snapshots.completions` -> extra window or fallback when premium is
  missing, label `Completions`

For each quota snapshot:

- prefer `percent_remaining`;
- if missing, derive from `remaining / entitlement` when both are usable;
- `usedPercent = 100 - remainingPercent`;
- clamp percentages to 0-100 for normal display;
- if `unlimited === true`, use `usedPercent = 0`, `remainingPercent = 100`,
  and omit reset;
- ignore placeholder snapshots where entitlement and remaining are both zero;
- accept snake_case and camelCase keys in mapper tests.

Reset fields:

- prefer quota-specific `quota_reset_at`;
- else use top-level `quota_reset_date_utc`;
- else use top-level `quota_reset_date`;
- parse ISO timestamps and `YYYY-MM-DD`;
- set `resetDescription` using the existing short human style.

Status:

- `available` when at least one usable quota window exists;
- `partial` when account/plan is known but no usable quota window exists;
- `unavailable` on auth/API/parse failure.

## Errors

Map common failures:

| Condition              | Error code                  |
| ---------------------- | --------------------------- |
| no token source        | `auth_missing`              |
| `gh` missing           | `auth_missing`              |
| `gh auth token` fails  | `auth_missing`              |
| API 401/403            | `auth_failed`               |
| API 404                | `provider_unavailable`      |
| timeout                | `timeout`                   |
| invalid JSON           | `invalid_provider_response` |
| no usable payload      | `invalid_provider_response` |
| network/server failure | `provider_unavailable`      |

All error messages must pass through the shared provider-limit redaction path.

## Tests

Add or extend `test/provider-limits.test.ts`:

- token resolution prefers `COPILOT_API_TOKEN`;
- token resolution falls back to `GITHUB_TOKEN`;
- token resolution falls back to `GH_TOKEN`;
- token resolution falls back to fake `gh auth token`;
- missing token returns unavailable `auth_missing`;
- 401/403 returns unavailable `auth_failed`;
- malformed JSON returns unavailable `invalid_provider_response`;
- premium/chat snapshots map to primary/secondary windows;
- `completions` snapshot maps as fallback or extra window;
- `quota_reset_date` maps to reset fields;
- token-based billing with no windows returns `partial`;
- placeholder zero snapshots are ignored;
- reader errors are redacted.

Add or extend `test/cli-limits.test.ts`:

- full JSON and compact JSON expose Copilot `available` snapshot through an
  injected/fake reader if needed;
- unsupported provider behavior remains unchanged.

Add opt-in live smoke:

```text
test/copilot-limits-smoke.test.ts
```

Guard:

```sh
RUN_COPILOT_LIMITS_SMOKE=1
```

The live smoke should accept `available`, `partial`, or `unavailable`; if a
local token works, assert the snapshot shape is valid. Do not require a specific
quota value.

## Non-Goals

- No browser-cookie budget extras.
- No GitHub billing web scraping.
- No GitHub OAuth device flow.
- No parsing Copilot private config files.
- No org/enterprise metrics reports.
- No cache.
- No parent-agent tool.
- No launch blocking.
- No automatic provider routing.
- No task usage changes.

## References

- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
- `adr/specs/provider-limit-intelligence-20260708-185157.md`
- `adr/research/SPIKE-copilot-limit-reader-20260708-211033.md`
- `adr/research/synthesis-copilot-limit-reader-20260708-211033.md`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Copilot/CopilotUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/CopilotUsageModels.swift`
- `/Users/ramos/oss/CodexBar/docs/copilot.md`
- GitHub CLI token docs: https://cli.github.com/manual/gh_auth_token
- GitHub Copilot request docs: https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests
- GitHub billing usage docs: https://docs.github.com/en/rest/billing/usage
- GitHub Copilot metrics docs: https://docs.github.com/en/rest/copilot/copilot-usage-metrics
