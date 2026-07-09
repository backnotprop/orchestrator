# Synthesis: Claude Limit Reader

Date: 2026-07-09

## Recommendation

Make Claude limits real by replacing the placeholder reader with a native
Claude OAuth usage reader and a CLI-auth fallback.

The command stays the same:

```sh
orchestrator limits --provider claude
orchestrator limits --provider claude --json --compact
```

Use the OAuth endpoint CodexBar identified:

```text
GET https://api.anthropic.com/api/oauth/usage
```

But do not depend on CodexBar, Keychain, browser cookies, or a terminal scrape.

## Source Order

Use this order:

1. Explicit OAuth token from environment.
2. Claude credentials file, if present and valid.
3. `claude auth status --json` as a partial account-only fallback.
4. Unavailable snapshot.

This gives Orchestrator useful behavior in every case:

- real windows when OAuth access is available;
- account/plan visibility when only Claude CLI auth status is available;
- clear unavailable errors when neither is available.

## Why Not PTY `/usage` First

CodexBar proves that `/usage` scraping can work, but it is a terminal automation
feature, not a clean CLI contract. It has to start Claude in a PTY, answer
startup prompts, wait for a rendered panel, retry if the panel is still loading,
parse ANSI text, and clean up generated session files.

That is too much fragility for the first Orchestrator core reader.

## Why Not Keychain Or Browser Cookies

CodexBar is a macOS app and can reasonably integrate with Keychain and browser
cookie stores. Orchestrator needs to work as a portable CLI and library.

Reading browser cookies, invoking macOS Keychain prompts, or silently repairing
Claude credentials would make the core reader harder to trust and harder to run
in CI, Linux, containers, or remote machines.

## Implementation Direction

Add a real Claude reader in:

```text
packages/core/src/provider-limits/claude.ts
packages/core/src/provider-limits/claude-mapping.ts
```

The reader should:

- resolve a Claude OAuth access token;
- call the OAuth usage endpoint with bounded timeout;
- map windows into `ProviderLimitSnapshot`;
- fall back to `claude auth status --json` for partial account data;
- return unavailable snapshots for normal auth/API/parse failures;
- redact secrets in every error path.

No CLI output or parser shape needs to change.

## What Not To Do

Do not add:

- browser cookie scraping;
- Claude web dashboard scraping;
- macOS Keychain reads;
- delegated Claude CLI credential repair;
- interactive `claude /usage` PTY scraping;
- provider auto-routing;
- launch blocking based on Claude limits;
- Orchestrator-stored Claude secrets.

Those can be revisited only after the OAuth and CLI-status paths are proven.

## References

- `adr/research/SPIKE-claude-limit-reader-20260709-075342.md`
- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
- `adr/specs/provider-limit-intelligence-20260708-185157.md`
- `adr/research/SPIKE-codexbar-provider-limit-intelligence-20260708-094729.md`
- `adr/specs/copilot-limit-reader-20260708-211033.md`
- `packages/core/src/provider-limits/claude.ts`
- `packages/core/src/provider-limits/copilot.ts`
- `/Users/ramos/oss/CodexBar/docs/claude.md`
