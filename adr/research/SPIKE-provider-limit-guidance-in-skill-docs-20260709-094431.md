# Provider Limit Guidance In Skill Docs Spike

Date: 2026-07-09

## Question

Where should Orchestrator teach agents about `orchestrator limits --json
--compact`, without telling agents how to make spending or routing decisions?

## Findings

The command already exists:

```sh
orchestrator limits [--provider codex|copilot|claude] [--timeout-ms <ms>] [--json [--compact]]
```

The current agent-facing help already mentions it, but some wording is too
directive:

- `packages/cli/src/commands/help.ts` says to use limits when provider capacity
  matters before large work.
- JSON help repeats the same idea in `agentInstructions`, `workflows`, and
  compact `agentQuickStart`.
- `skills/orchestrator/SKILL.md` does not have a focused provider-limit section.
- `README.md` does not show `orchestrator limits` in the main command list.

The provider-limit model reports account snapshots and errors. It is separate
from task token usage. It does not route work, block launches, or decide which
provider to use.

## Recommendation

Update the skill, help contract, and README with neutral capability language:

- show the command;
- explain that it returns provider limit snapshots for Codex, Copilot, and
  Claude when readers can access them;
- say unavailable/partial snapshots are normal;
- avoid telling agents when to spend, avoid, route, or switch providers.

No new provider-limit runtime behavior is needed.

## References

- `packages/cli/src/commands/help.ts`
- `skills/orchestrator/SKILL.md`
- `README.md`
- `adr/decisions/0060-add-provider-limit-intelligence-20260708-185717.md`
