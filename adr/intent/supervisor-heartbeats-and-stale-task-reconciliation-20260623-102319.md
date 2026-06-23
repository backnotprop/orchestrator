# Intent: Supervisor Heartbeats and Stale Task Reconciliation

Add heartbeat-based stale task detection so Orchestrator stops presenting old
task records as trustworthy active work after it loses the internal watcher for
an agent. The problem is not that the agent necessarily failed; the problem is
that Orchestrator no longer knows the truth. We want users, scripts, and parent
agents to see that difference clearly instead of waiting forever, retrying
useless interrupts, or assuming budget is still burning when the saved status is
just stale.

Preserve the durable task outcome model and expose supervision health through
observed state. `status` should continue to mean the durable outcome, such as
`running`, `succeeded`, `failed`, `cancelled`, or `timed_out`. `state` should
mean what Orchestrator currently observes, including `stopping`, `stale`,
`orphaned`, and `lost`. This keeps `failed` and `cancelled` honest while still
giving operators and agents the state they need to act.

Implement this without adding a daemon yet. The watcher should write heartbeat
data to a separate `heartbeat.json` file, not to `task.json`, so frequent
heartbeat writes cannot race with final task status writes. The task model
should record process identity, not just raw PIDs, because PIDs can be reused.
If Orchestrator cannot verify process identity, it should degrade to `stale`
and must not signal the process as if it were definitely the original child.

Thread the observed task state through the control plane, not only the human
renderer. `ps`, compact `ps`, group summaries, `--active` filtering, stop
targets, `list`, `read`, `read --wait`, `interrupt`, compact JSON, and
parent-agent tool summaries must all use the same observation model. `read
--wait` and `read_agent({ wait: true })` should not wait forever on work that is
already observed as `stale`, `orphaned`, or `lost`; they should return that
state clearly.

Build this in slices: first add passive heartbeat and observed state into `ps`
and compact `ps`; then integrate `list`, `read`, wait behavior, and parent-agent
tools; then make `interrupt` safe for stale/orphaned/lost tasks with explicit
skip reasons; finally consider optional reconciliation writeback events if the
read-time model proves useful.

References:

- `adr/research/SPIKE-supervisor-heartbeats-and-stale-task-reconciliation-20260623-095805.md`
- `adr/research/synthesis-supervisor-heartbeats-and-stale-task-reconciliation-20260623-100342.md`
- `adr/specs/supervisor-heartbeats-and-stale-task-reconciliation-20260623-100342.md`
- `adr/decisions/0045-add-supervisor-heartbeats-and-stale-task-reconciliation-20260623-102201.md`
- `adr/decisions/0044-model-interrupt-as-stop-request-metadata-20260623-075635.md`
- `doc/internal/supervision-model.svg`
