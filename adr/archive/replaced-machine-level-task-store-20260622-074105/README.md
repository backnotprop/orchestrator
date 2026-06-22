# Archived Machine-Level Task Store Docs

These documents were archived because they modeled repo-local and global task
stores as two equal product modes.

The active direction is now the single control-plane model:

- default store: `~/.orchestrator/tasks`;
- workspace: task metadata and default view filter;
- `cwd`: process execution directory;
- `ps`: current workspace;
- `ps -A`: all workspaces.

Archived files:

- `SPIKE-machine-level-task-store-20260622-071616.md`
- `synthesis-machine-level-task-store-20260622-071616.md`
- `machine-level-task-store-20260622-071616.md`
