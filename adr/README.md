# Architecture Decision Records

This is the canonical ADR workspace.

- `decisions/`: accepted architecture decisions
- `research/`: research spikes used to inform decisions
- `specs/`: draft specs used before a decision is final

## Backlog

- [Job-control UX backlog](specs/job-control-ux-backlog-20260619-203821.md)
- [Service and Slack interface backlog](specs/service-and-slack-interface-backlog-20260623.md)

## Specs

- [Short ID resolution](specs/short-id-resolution-20260619-205022.md)
- [Group and parent interruption](specs/group-and-parent-interruption-20260619-231405.md)
- [Compact machine control view](specs/compact-machine-control-view-20260620-082105.md)
- [Batch launch CLI](specs/batch-launch-cli-20260622-050535.md)
- [Local returned command args](specs/local-returned-command-args-20260622-063117.md)
- [Single control-plane task store](specs/single-control-plane-task-store-20260622-074105.md)
- [Persist parent events for background runs](specs/persist-parent-events-for-background-runs-20260630-104204.md)
- [Parent launch_agent runtime guidance](specs/parent-launch-agent-runtime-guidance-20260630-111352.md)
- [Codex app-server resume](specs/codex-app-server-resume-20260630-163105.md)
- [Send messages to running Codex app-server tasks](specs/codex-app-server-steering-20260630-232736.md)
- [Codex app-server persistent sessions and goal operations](specs/codex-app-server-persistent-session-operations-20260701-092650.md)
- [Parent-agent session control language](specs/parent-agent-session-control-language-20260703-203248.md)
- [Codex app-server goal start operation](specs/codex-app-server-goal-start-operation-20260704-122339.md)
- [Codex app-server goal get, set, and clear](specs/codex-app-server-goal-get-set-clear-20260704-180935.md)

## Intent Notes

- [Batch launch manifests](intent/batch-launch-manifests-20260622-055107.md)
- [Single control-plane task store](intent/single-control-plane-task-store-20260622-075137.md)
- [Send messages to running Codex app-server tasks](intent/send-messages-to-running-codex-app-server-tasks-20260701.md)

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
- [25. Normalize token usage at runtime adapter boundaries](decisions/0025-normalize-token-usage-at-runtime-adapter-boundaries-20260619-154303.md)
- [26. Accept short task ID prefixes](decisions/0026-accept-short-task-id-prefixes-20260619-212812.md)
- [27. Add group and safer parent interruption](decisions/0027-add-group-and-safer-parent-interruption-20260619-231629.md)
- [28. Add compact machine control view](decisions/0028-add-compact-machine-control-view-20260620-082105.md)
- [29. Add batch launch manifests](decisions/0029-add-batch-launch-manifests-20260622-054900.md)
- [30. Use single control-plane task store](decisions/0030-use-single-control-plane-task-store-20260622-074546.md)
- [31. Extract run command execution from CLI](decisions/0031-extract-run-command-execution-from-cli-20260622-130242.md)
- [32. Extract task inspection commands from CLI](decisions/0032-extract-task-inspection-commands-from-cli-20260622-134039.md)
- [33. Extract watch command execution from CLI](decisions/0033-extract-watch-command-execution-from-cli-20260622-154207.md)
- [34. Extract ps command execution from CLI](decisions/0034-extract-ps-command-execution-from-cli-20260622-182831.md)
- [35. Extract interrupt command execution from CLI](decisions/0035-extract-interrupt-command-execution-from-cli-20260622-185318.md)
- [36. Extract doctor command execution from CLI](decisions/0036-extract-doctor-command-execution-from-cli-20260622-191454.md)
- [37. Extract help command contract from CLI](decisions/0037-extract-help-command-contract-from-cli-20260622-193136.md)
- [38. Extract list command execution from CLI](decisions/0038-extract-list-command-execution-from-cli-20260622-201419.md)
- [39. Extract parser primitives from CLI](decisions/0039-extract-parser-primitives-from-cli-20260622-203723.md)
- [40. Add common option parser helper](decisions/0040-add-common-option-parser-helper-20260622-205422.md)
- [41. Clean up task inspection parsers](decisions/0041-clean-up-task-inspection-parsers-20260622-212320.md)
- [42. Clean up heavy CLI parsers](decisions/0042-clean-up-heavy-cli-parsers-20260623-044430.md)
- [43. Extract parser functions from CLI](decisions/0043-extract-parser-functions-from-cli-20260623-062013.md)
- [44. Model interrupt as stop request metadata](decisions/0044-model-interrupt-as-stop-request-metadata-20260623-075635.md)
- [45. Add supervisor heartbeats and stale task reconciliation](decisions/0045-add-supervisor-heartbeats-and-stale-task-reconciliation-20260623-102201.md)
- [46. Extract task executor foundation for protocol runtimes](decisions/0046-extract-task-executor-foundation-for-protocol-runtimes-20260624-055627.md)
- [47. Build internal JSON-RPC stdio client](decisions/0047-build-internal-json-rpc-stdio-client-20260624-065645.md)
- [48. Add Codex app-server protocol executor](decisions/0048-add-codex-app-server-protocol-executor-20260624-084935.md)
- [49. Polish Codex app-server runtime with live smoke](decisions/0049-polish-codex-app-server-runtime-with-live-smoke-20260624-113358.md)
- [50. Use simple task-shaped resume before pooling](decisions/0050-use-simple-task-shaped-resume-before-pooling-20260630-051045.md)
- [51. Persist parent events for background runs](decisions/0051-persist-parent-events-for-background-runs-20260630-104204.md)
- [52. Enable task-shaped resume for Codex app-server](decisions/0052-enable-task-shaped-resume-for-codex-app-server-20260630-163334.md)
- [53. Send messages to running Codex app-server tasks through file-backed control requests](decisions/0053-send-messages-to-running-codex-app-server-tasks-20260630-234839.md)
- [54. Use persistent Codex app-server sessions for goal work](decisions/0054-use-persistent-codex-app-server-sessions-for-goal-work-20260701-104716.md)
- [55. Hide provider turn mechanics behind session operations](decisions/0055-hide-provider-turn-mechanics-behind-session-operations-20260704-094016.md)
