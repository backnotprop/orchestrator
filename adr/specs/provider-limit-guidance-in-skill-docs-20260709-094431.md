# Provider Limit Guidance In Skill Docs

Date: 2026-07-09

## Intent

Make agents aware that Orchestrator can read provider limit snapshots, without
teaching agents to make budget, spend, or routing judgments.

## Scope

Update the existing skill/docs/help surfaces:

- add a short provider-limits note to `skills/orchestrator/SKILL.md`;
- neutralize `limits` language in `packages/cli/src/commands/help.ts`;
- add `orchestrator limits --json --compact` to the README command list with a
  short factual note.

## Language Rules

Use neutral capability language:

- "Run limits when software needs provider limit snapshots."
- "Use `--provider codex|copilot|claude` to inspect one provider."
- "Snapshots may be available, partial, or unavailable."

Avoid policy language:

- do not say agents should call limits before large work;
- do not tell agents to pick cheaper providers;
- do not tell agents to avoid spending;
- do not imply Orchestrator auto-routes or blocks launches.

## Tests

Update existing help-contract tests to assert the neutral provider-limit
language instead of "capacity matters" wording.

Run:

```sh
pnpm check
```

## References

- `adr/research/SPIKE-provider-limit-guidance-in-skill-docs-20260709-094431.md`
- `adr/research/synthesis-provider-limit-guidance-in-skill-docs-20260709-094431.md`
- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
