<p>
  <img src="./assets/orchestrator_tp.webp" alt="Orchestrator" width="280">
</p>

# Orchestrator

**Use your harness. To orchestrate many others.**

<p>
  <a href="https://openai.com/codex/"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/providers/codex-icon-dark.png"><img src="./assets/providers/codex-icon-light.png" alt="Codex" width="32" height="32" align="middle"></picture></a>
  &nbsp;&nbsp;
  <a href="https://claude.com/product/claude-code"><img src="./assets/providers/claude-icon.png" alt="Claude Code" width="28" height="28" align="middle"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/providers/copilot-icon-dark.svg"><img src="./assets/providers/copilot-icon-light.svg" alt="GitHub Copilot CLI" width="32" height="26" align="middle"></picture></a>
  &nbsp;&nbsp;
  <a href="https://grok.com/"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/providers/grok-logo-white.svg"><img src="./assets/providers/grok-logo-black.svg" alt="Grok" width="63" height="24" align="middle"></picture></a>
  &nbsp;&nbsp;
  <a href="https://pi.dev/"><img src="./assets/providers/pi-badge.svg" alt="Pi" width="26" height="26" align="middle"></a>
</p>

<sub>Codex &middot; Claude Code &middot; Copilot CLI &middot; Grok Build &middot; Pi</sub>

Orchestrator is a simple skill built on a powerful local CLI (inspired by Kubectl). Work with
one of your agents; it orchestrates others (Claude Code, Codex, etc) in the background. 

You speak in models and outcomes:

> Use Fable for the UI, GPT-5.6 Sol for the implementation, and Grok 4.5 for
> the small fixes. Run independent work in parallel, then have Opus review the
> result.

> Explore the repository with Kimi 2.7. Give the plan to GPT-5.6 Sol, then use
> Fable only where the interface needs real design work.

## Install

```sh
npx skills add backnotprop/orchestrator
```

```sh
npm install -g @backnotprop/orchestrator-cli
```

The CLI install is optional up front. The skill can install it on first use.

```sh
/orchestrator launch a gpt5.6 sol agent to build the backend, 
              a fable agent to design the frontend wireframes, 
              and after that a grok4.5 agent to build the frontend
```

## Preferences

Preferences are optional. Edit
[`skills/orchestrator/PREFERENCES.md`](skills/orchestrator/PREFERENCES.md), or
tell your agent what to put there:

```text
Use Fable for extensive UI work.
Use GPT-5.6 Sol for deep execution.
Use Grok 4.5 for small coding tasks.
Use Kimi 2.7 for exploration.
When Fable is usage is capped, use GPT-5.6 Sol.
When GPT-5.6 Sol is unavailable, use Opus.
When every preferred model is unavailable, pause and notify me.
```

Orchestrator discovers current model names and IDs from installed runtimes
instead of relying on stale model slugs.

Human model names are fine. The skill resolves them against live runtime
catalogs, checks available provider limits when supported, and follows the
current request before saved preferences.

## Under The Hood

Orchestrator is not a harness. You use it in your preferred harness and it orchestrates others in the background.

Every worker is a named task with status, logs, output, follow-up, resume, and
stop controls. Agents use a small JSON command loop:

```sh
orchestrator doctor --json --compact
orchestrator models <runtime> --json --compact
orchestrator launch <runtime> --json --compact --brief "<task>"
orchestrator ps --json --compact --active --brief
orchestrator read <task-id>... --wait --json --compact
orchestrator interrupt <task-id> --json --compact --reason "<reason>"
```

The CLI owns process supervision and task state. The calling agent owns
judgment, delegation, and synthesis.

Read the [Operator Guide](doc/operator-guide.md) for the full control contract,
or see [custom agents](doc/custom-agents.md), [architecture decisions](adr/README.md)

## License

[Business Source License 1.1](LICENSE) today, with production use allowed except
for commercial hosted or managed agent-orchestration services. Converts to
Apache License 2.0 on July 9, 2029.
