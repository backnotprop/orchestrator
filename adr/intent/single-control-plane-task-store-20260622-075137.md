# Intent: Single control-plane task store

Date: 2026-06-22

We want Orchestrator to feel like one control plane for agents. Instead of each
repo owning its own default task store, Orchestrator should manage tasks from one
machine-level store at `~/.orchestrator/tasks`. Workspaces should describe where
work belongs, and `cwd` should describe where the agent process runs. That gives
us one model for humans, agents, the future TUI, and any machine-readable control
flow.[^adr30]

The reason is scale and clarity. The product direction is not "open a repo and
run one helper." It is "manage many agents across many projects." A Kubernetes
style model fits that: `ps` shows the current workspace, `ps -A` shows all
workspaces, and task IDs can be read, watched, logged, or interrupted from the
same store. This removes the awkward split between repo-local and global modes.
It also makes batch launch and parent-agent orchestration cleaner because one
parent can launch children across multiple workspaces without changing stores.
[^adr23][^adr29]

The implementation should be staged as a boundary refactor, not a rewrite. First
add task location metadata while preserving current behavior. Then add a
machine-store resolver, keep `--orchestrator-dir` as an advanced override, switch
new launches to the machine store, make `ps` filter by current workspace, add
`-A` / `--all-workspaces`, and update compact JSON returned commands so they no
longer carry unnecessary `--workspace` args for ID-based task commands. Batch
launch and parent-agent tools should then accept per-task `workspace` and `cwd`.
[^adr28][^adr30]

This should not change the core idea of a task. Runtime adapters, launch plans,
logs, events, token usage, interruption, and compact machine control remain the
foundation. The main change is separating storage from project scope and process
execution directory.

[^adr23]: [ADR 23: Build multi-agent operations view from task state](../decisions/0023-build-multi-agent-operations-view-from-task-state-20260618-145801.md)

[^adr28]: [ADR 28: Add compact machine control view](../decisions/0028-add-compact-machine-control-view-20260620-082105.md)

[^adr29]: [ADR 29: Add batch launch manifests](../decisions/0029-add-batch-launch-manifests-20260622-054900.md)

[^adr30]: [ADR 30: Use single control-plane task store](../decisions/0030-use-single-control-plane-task-store-20260622-074546.md)
