# Intent: Batch launch manifests

Date: 2026-06-22

We want Orchestrator to let an agent start several child agents with one CLI
call. Today, a caller can manage many tasks after they exist, but it still has
to run `orchestrator launch` once per child agent. Batch launch closes that gap
without changing what a task is.[^adr6][^adr29]

The purpose is speed and control. An agent should be able to send one JSON
manifest, get back all task IDs, then use one returned wait command or one
returned stop command. That keeps the CLI useful for agents without making
humans learn a second system.[^adr26][^adr27][^adr28]

The implementation should add file/stdin mode to the existing `launch` command:

```sh
orchestrator launch -f agents.json --json --compact --brief
orchestrator launch -f - --json --compact --brief
```

The manifest should be preflighted before any task starts. If the manifest is
bad, nothing launches. If a child agent fails after launch, it is just a normal
task failure and can be inspected with `read`, `logs`, `events`, `ps`, and
`interrupt`.[^adr29]

This should reuse the current runtime registry, launch-plan building, headless
adapter behavior, task store, compact JSON summaries, and batch control
commands. It should not create a new supervisor, a durable batch object, a
workflow engine, or a declarative `apply` model.[^adr5][^adr7][^adr28][^adr29]

[^adr5]: [ADR 5: Use typed runtime registry and pure launch plan builders](../decisions/0005-use-typed-runtime-registry-and-pure-launch-plan-builders.md)

[^adr6]: [ADR 6: Treat subagents as durable asynchronous task sessions](../decisions/0006-treat-subagents-as-durable-asynchronous-task-sessions.md)

[^adr7]: [ADR 7: Launch external agents through headless runtime adapters](../decisions/0007-launch-external-agents-through-headless-runtime-adapters.md)

[^adr26]: [ADR 26: Accept short task ID prefixes](../decisions/0026-accept-short-task-id-prefixes-20260619-212812.md)

[^adr27]: [ADR 27: Add group and safer parent interruption](../decisions/0027-add-group-and-safer-parent-interruption-20260619-231629.md)

[^adr28]: [ADR 28: Add compact machine control view](../decisions/0028-add-compact-machine-control-view-20260620-082105.md)

[^adr29]: [ADR 29: Add batch launch manifests](../decisions/0029-add-batch-launch-manifests-20260622-054900.md)
