# Synthesis: Provider Limit Guidance In Skill Docs

Date: 2026-07-09

## Recommendation

Teach agents that provider limits are available as a factual command surface,
not as a policy engine.

The right language is:

```sh
orchestrator limits --json --compact
orchestrator limits --provider codex --json --compact
```

The response gives provider snapshots. It can be `available`, `partial`, or
`unavailable`. Agents should treat it as information they can report or inspect,
not as an instruction to spend, avoid spending, auto-route, or override user
intent.

## Surfaces

Update:

- `skills/orchestrator/SKILL.md`
- `packages/cli/src/commands/help.ts`
- `README.md`

Do not add a new long doc. The command is small and belongs in the existing
agent-facing contract.

## References

- `adr/research/SPIKE-provider-limit-guidance-in-skill-docs-20260709-094431.md`
- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
