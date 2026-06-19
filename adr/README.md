# Architecture Decision Records

This is the canonical ADR workspace.

- `decisions/`: accepted architecture decisions
- `research/`: research spikes used to inform decisions
- `specs/`: draft specs used before a decision is final

## Decisions

- [1. Record architecture decisions](decisions/0001-record-architecture-decisions.md)
- [2. Build a focused coding orchestrator agent](decisions/0002-build-a-focused-coding-orchestrator-agent.md)
- [3. Reuse Pi for orchestrator brain provider model auth](decisions/0003-reuse-pi-for-orchestrator-brain-provider-model-auth.md)
- [4. Separate model provider registry from agent runtime registry](decisions/0004-separate-model-provider-registry-from-agent-runtime-registry.md)
- [5. Use typed runtime registry and pure launch plan builders](decisions/0005-use-typed-runtime-registry-and-pure-launch-plan-builders.md)
- [6. Treat subagents as durable asynchronous task sessions](decisions/0006-treat-subagents-as-durable-asynchronous-task-sessions.md)
- [7. Launch external agents through headless runtime adapters](decisions/0007-launch-external-agents-through-headless-runtime-adapters.md)
- [8. Do not require structured worker output in V1](decisions/0008-do-not-require-structured-worker-output-in-v1.md)
- [9. Keep core frontend independent with CLI TUI later](decisions/0009-keep-core-frontend-independent-with-cli-tui-later.md)
- [10. Use worktree isolation for writable workers](decisions/0010-use-worktree-isolation-for-writable-workers.md)
- [11. Keep subagent orchestration parent directed without prebaked recipes](decisions/0011-keep-subagent-orchestration-parent-directed-without-prebaked-recipes.md)
- [12. Scope first release to Claude Code and Codex runtimes](decisions/0012-scope-first-release-to-claude-code-and-codex-runtimes.md)
- [13. Keep CLI job ergonomics lean with launch names, name-first lists, and follow logs](decisions/0013-keep-cli-job-ergonomics-lean-with-launch-names-list-names-and-follow-logs.md)
- [14. Use JSON config for custom sub-agent runtimes](decisions/0014-use-json-config-for-custom-sub-agent-runtimes.md)
- [15. Allow config to disable built-in agent runtimes](decisions/0015-allow-config-to-disable-built-in-agent-runtimes.md)
- [16. Package Orchestrator usage as an agent skill](decisions/0016-package-orchestrator-usage-as-an-agent-skill.md)
- [17. Build parent AI agent as Pi-backed package over Orchestrator core](decisions/0017-build-parent-ai-agent-as-pi-backed-package-over-orchestrator-core.md)
- [18. Add parent-agent doctor command](decisions/0018-add-parent-agent-doctor-command.md)
- [19. Use host-side waiting reads for parent agent coordination](decisions/0019-use-host-side-waiting-reads-for-parent-agent-coordination-20260618-080018.md)
- [20. Use parent tool-call trace stream for live observability](decisions/0020-use-parent-tool-call-trace-stream-for-live-observability-20260618-085735.md)
- [21. Support JSON and pretty run streams](decisions/0021-support-json-and-pretty-run-streams-20260618-095042.md)
- [22. Standardize parent run event stream contract](decisions/0022-standardize-parent-run-event-stream-contract-20260618-110432.md)
- [23. Build multi-agent operations view from task state](decisions/0023-build-multi-agent-operations-view-from-task-state-20260618-145801.md)
- [24. Run parent agent as managed background task](decisions/0024-run-parent-agent-as-managed-background-task-20260618-193203.md)
