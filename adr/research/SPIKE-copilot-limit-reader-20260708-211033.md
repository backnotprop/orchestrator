# Copilot Limit Reader Spike

Date: 2026-07-08

## Question

What does it take to make this real?

```sh
orchestrator limits --provider copilot
```

## Current Orchestrator State

Copilot is already a first-class process runtime. The runtime uses GitHub
Copilot CLI in programmatic mode and already has launch, JSONL normalization,
usage extraction, provider session metadata, and resume support.

The provider-limit path is different. `packages/core/src/provider-limits/copilot.ts`
still returns `not_implemented`. The shared limit model and CLI command already
exist, so the Copilot slice only needs to replace that placeholder with a real
reader.

Relevant files:

- `packages/core/src/provider-limits/copilot.ts`
- `packages/core/src/provider-limits/types.ts`
- `packages/core/src/provider-limits/readers.ts`
- `packages/cli/src/commands/limits.ts`
- `packages/cli/src/parsing/limits.ts`
- `test/cli-limits.test.ts`
- `test/provider-limits.test.ts`

## Prior ADR Context

ADR 0060 says Copilot should be built after Codex and should use a supported
local GitHub/Copilot auth source plus the Copilot usage API.

The provider-limit spec names the likely endpoint:

```text
GET https://api.github.com/copilot_internal/user
```

It also says not to scrape GitHub billing pages in the first Copilot slice.

## CodexBar Findings

CodexBar uses a GitHub OAuth token and calls:

```text
GET https://api.github.com/copilot_internal/user
```

Headers:

```text
Authorization: token <github_oauth_token>
Accept: application/json
Editor-Version: vscode/1.96.2
Editor-Plugin-Version: copilot-chat/0.26.7
User-Agent: GitHubCopilotChat/0.26.7
X-Github-Api-Version: 2025-04-01
```

CodexBar maps:

- `quota_snapshots.premium_interactions` to premium usage;
- `quota_snapshots.chat` to chat usage;
- `quota_reset_date` to reset date;
- `copilot_plan` to plan/account label;
- token-based billing plans as valid account state even when normal quota
  windows are missing.

CodexBar has optional GitHub web budget scraping, but that depends on browser
cookies and billing pages. Do not copy that into this slice.

Relevant CodexBar files:

- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Copilot/CopilotUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/CopilotUsageModels.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Copilot/CopilotProviderDescriptor.swift`
- `/Users/ramos/oss/CodexBar/docs/copilot.md`

## Local Probe

`copilot --help` confirms Copilot CLI is installed locally. It exposes
programmatic mode, but no direct command for account limit snapshots.

`gh auth status` shows the active GitHub account is authenticated. A local probe
using `gh auth token --hostname github.com` successfully called:

```text
https://api.github.com/copilot_internal/user
```

The response was `200` and included:

- `login`
- `copilot_plan`
- `token_based_billing`
- `quota_reset_date`
- `quota_reset_date_utc`
- `quota_snapshots`
- `quota_snapshots.premium_interactions`
- `quota_snapshots.chat`
- `quota_snapshots.completions`

The live response shape included `percent_remaining`, `remaining`,
`quota_remaining`, `unlimited`, `quota_reset_at`, and billing flags.

No token or raw secret data was printed during the probe.

## Official Docs Findings

GitHub CLI documents `gh auth token` as the command that outputs the active
account token for a host. It also documents that `gh auth login` stores tokens
through the system credential store when available.

GitHub Copilot docs describe premium request and AI credit usage, including that
Copilot CLI usage consumes premium requests or credits depending on plan/billing
mode.

The official REST billing and Copilot metrics docs are mostly admin,
organization, or enterprise shaped. They do not provide a simple local
developer endpoint equivalent to the client quota snapshot. For individual user
and managed-org cases, the official billing APIs are not a good first
implementation target for this CLI command.

References:

- https://cli.github.com/manual/gh_auth_token
- https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests
- https://docs.github.com/en/rest/billing/usage
- https://docs.github.com/en/rest/copilot/copilot-usage-metrics
- https://docs.github.com/en/copilot/concepts/usage-limits

## Auth Source Recommendation

Use this auth order:

1. `COPILOT_API_TOKEN`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `gh auth token --hostname github.com`

Rationale:

- explicit env is easiest to test and safest in CI;
- `gh auth token` is the normal developer-machine source and worked locally;
- parsing `~/.copilot/config.json` is not a good first source because the local
  file is not plain JSON and is private application state;
- no token should ever be printed, cached, or written by Orchestrator.

## Mapping Recommendation

Create a Copilot reader and mapper:

```text
packages/core/src/provider-limits/copilot.ts
packages/core/src/provider-limits/copilot-mapping.ts
```

Map:

- provider: `copilot`
- source: `copilot-api`
- confidence: `exact`
- account.username: `login`
- account.plan: `copilot_plan`
- account.loginMethod: `github`
- primary window: `quota_snapshots.premium_interactions`
- secondary window: `quota_snapshots.chat`
- optional extra/fallback window: `quota_snapshots.completions`
- reset: quota-specific `quota_reset_at`, then top-level `quota_reset_date_utc`,
  then top-level `quota_reset_date`

For each quota snapshot:

- `usedPercent = 100 - percent_remaining`
- `remainingPercent = percent_remaining`
- clamp percentages to a reasonable range
- when `unlimited` is true, show `0% used` and no reset
- when a snapshot is a zero-placeholder, ignore it
- if plan is token-based billing and windows are missing, return `partial`
  rather than fabricating usage

## Error Handling

Return unavailable snapshots for normal failures:

- no token source: `auth_missing`
- `gh` missing: `auth_missing`
- `gh auth token` fails: `auth_missing`
- API 401/403: `auth_failed`
- API 404: `provider_unavailable`
- API timeout: `timeout`
- malformed payload: `invalid_provider_response`
- other network/server failure: `provider_unavailable`

Redact token-looking strings in all errors.

## Non-Goals

- No browser budget scraping.
- No GitHub billing-page scraping.
- No Copilot private config parsing.
- No GitHub device flow in Orchestrator.
- No enterprise/org metrics reports in this slice.
- No provider routing.
- No launch blocking.
- No task usage changes.
- No parent-agent tool.

## Conclusion

This is implementation-ready. The simplest real slice is a native Copilot API
reader that obtains a token from env or GitHub CLI, calls
`/copilot_internal/user`, maps quota windows, and degrades cleanly when the
local account cannot expose that data.
