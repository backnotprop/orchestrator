# Synthesis: Copilot Limit Reader

Date: 2026-07-08

## Recommendation

Make Copilot limits real by replacing the placeholder reader with a native
GitHub token reader and a Copilot usage fetcher.

The command stays the same:

```sh
orchestrator limits --provider copilot
orchestrator limits --provider copilot --json --compact
```

The first implementation should use:

```text
GET https://api.github.com/copilot_internal/user
```

This endpoint is what the client-facing Copilot quota path uses. A live local
probe confirmed it returns plan, login, quota reset date, and premium/chat quota
snapshots with the active GitHub CLI token.

## Why This Is The Right Slice

This gives humans and agents useful information before launching Copilot work:

- which GitHub/Copilot account is active;
- whether Copilot usage data is available;
- premium request or AI-credit room when GitHub returns it;
- chat quota when GitHub returns it;
- reset timing when GitHub returns it.

It fits the existing provider-limit model. No CLI shape changes are needed.

## Auth Decision

Use this token order:

1. `COPILOT_API_TOKEN`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `gh auth token --hostname github.com`

Do not parse `~/.copilot/config.json` in this slice. The local file is private
application state and not plain JSON on this machine.

Do not implement GitHub OAuth device flow in Orchestrator. Users already have
normal GitHub auth paths through GitHub CLI and explicit env vars.

## Data Mapping

Map Copilot payloads into `ProviderLimitSnapshot`:

- account username from `login`;
- plan from `copilot_plan`;
- source `copilot-api`;
- primary window from `quota_snapshots.premium_interactions`;
- secondary window from `quota_snapshots.chat`;
- fallback/extra window from `quota_snapshots.completions` if needed;
- reset from `quota_reset_at`, `quota_reset_date_utc`, or `quota_reset_date`.

If GitHub returns token-based billing without usable quota windows, return
`partial` with account/plan instead of making up percentages.

## What Not To Do

Do not add:

- browser-cookie budget scraping;
- GitHub billing web scraping;
- org/enterprise usage reports;
- provider-limit caching;
- parent-agent tool wiring;
- launch blocking or auto-routing.

Those are separate decisions. The next useful move is simply making
`limits --provider copilot` answer with a real snapshot.

## References

- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
- `adr/specs/provider-limit-intelligence-20260708-185157.md`
- `adr/research/SPIKE-copilot-limit-reader-20260708-211033.md`
- `adr/research/SPIKE-codexbar-provider-limit-intelligence-20260708-094729.md`
- `adr/decisions/0059-add-github-copilot-cli-process-runtime-20260707-175401.md`
- `adr/specs/github-copilot-cli-supported-runtime-20260707-173501.md`
- GitHub CLI token docs: https://cli.github.com/manual/gh_auth_token
- GitHub Copilot request docs: https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests
- GitHub billing usage docs: https://docs.github.com/en/rest/billing/usage
- GitHub Copilot metrics docs: https://docs.github.com/en/rest/copilot/copilot-usage-metrics
