# Claude Limit Reader Spike

Date: 2026-07-09

## Question

How should Orchestrator make `orchestrator limits --provider claude` return real
Claude capacity data without depending on CodexBar or copying macOS-app-specific
behavior?

## Current Orchestrator State

The provider-limit surface already exists:

- `packages/core/src/provider-limits/types.ts`
- `packages/core/src/provider-limits/readers.ts`
- `packages/cli/src/commands/limits.ts`
- `packages/cli/src/parsing/limits.ts`

Codex and Copilot have real readers. Claude is still a placeholder in
`packages/core/src/provider-limits/claude.ts`, returning `not_implemented`.

The shared model already has the right source names:

- `claude-oauth`
- `claude-cli`

No CLI contract change is needed.

## Prior ADR Context

`adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md` says
Claude should be built after Codex and Copilot, using the least brittle source we
can prove.

`adr/specs/provider-limit-intelligence-20260708-185157.md` says Claude source
order should be:

1. Claude OAuth/API if a stable credential source exists.
2. Claude CLI `/usage` PTY only if reliable and bounded.
3. Unavailable snapshot.

It also explicitly says not to scrape browser dashboards or rely on macOS-only
Keychain behavior in the first core implementation.

## CodexBar Findings

CodexBar has four Claude data paths:

1. OAuth API.
2. Claude web API using browser cookies.
3. CLI PTY scrape of `/usage`.
4. Local log scan for cost/token history.

The useful source for Orchestrator core is OAuth:

```text
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <access_token>
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/<version>
```

CodexBar maps:

- `five_hour` to the current session window;
- `seven_day` to the weekly window;
- `seven_day_sonnet` and `seven_day_opus` to model-specific weekly windows;
- `seven_day_routines` / `seven_day_cowork` to an extra routines window;
- `limits[]` to scoped model windows;
- `extra_usage` to monthly extra usage spend/limit.

CodexBar credential sources are more app-specific:

- `CODEXBAR_CLAUDE_OAUTH_TOKEN`
- CodexBar cache
- `~/.claude/.credentials.json`
- macOS Keychain service `Claude Code-credentials`
- optional delegated repair through Claude CLI

Those mechanisms are not all appropriate for Orchestrator. Keychain reads,
browser cookie import, and delegated repair are macOS-app concerns, not a clean
cross-platform CLI foundation.

## Local Claude CLI Findings

Local Claude Code version:

```text
claude --version
2.1.205 (Claude Code)
```

`claude --help` does not expose a direct `limits` or `usage` command.

Useful non-interactive auth command:

```sh
claude auth status --json
```

It returns structured account data such as:

- `loggedIn`
- `authMethod`
- `apiProvider`
- `email`
- `orgId`
- `orgName`
- `subscriptionType`

That does not give usage windows, but it is useful as a partial fallback.

`~/.claude/.credentials.json` is not present on this machine. That means the
reader cannot assume a file source will exist for modern Claude Code installs.

## Recommendation

Implement Claude in two layers:

1. `claude-oauth` returns real limit windows when an explicit OAuth token or
   readable Claude credentials file is available.
2. `claude-cli` returns a partial snapshot from `claude auth status --json` when
   OAuth usage data is unavailable.

Do not implement CLI `/usage` PTY scraping in this slice. It is real in
CodexBar, but it is a fragile terminal scrape with startup prompts, rendering
timing, retry behavior, and cleanup concerns.

Do not implement browser cookie import or Keychain reads in Orchestrator core.

## Open Questions

- Whether Claude Code will keep `~/.claude/.credentials.json` stable enough to
  treat as a first-class file source.
- Whether we should later add refresh-token support for Claude credential files.
- Whether a future Claude CLI exposes a proper non-interactive usage command.

Those do not block a first real reader.

## References

- `packages/core/src/provider-limits/claude.ts`
- `packages/core/src/provider-limits/types.ts`
- `packages/cli/src/commands/limits.ts`
- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
- `adr/specs/provider-limit-intelligence-20260708-185157.md`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthCredentialModels.swift`
- `/Users/ramos/oss/CodexBar/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift`
- `/Users/ramos/oss/CodexBar/docs/claude.md`
