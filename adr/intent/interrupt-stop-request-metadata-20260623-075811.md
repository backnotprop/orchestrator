# Interrupt Stop Request Metadata Intent

Model interruption honestly by separating "stop requested" from "fully
stopped." When a user or agent interrupts a task, Orchestrator should record
that a stop was requested, keep the task active while the process is still
shutting down, and show that state as `stopping` in human and compact control
views. Only after the process exits and final output/events are written should
the task become `cancelled`.

This prevents users and agents from seeing a task as stopped before it actually
is. It also makes `read --wait`, `ps --watch`, compact JSON, and the future TUI
more truthful. The implementation should add stop-request metadata to task
records, add a shared display-state helper, update interrupt/read/ps/tool
summaries to use it, and cover delayed shutdown behavior in tests.

References:

- `adr/research/SPIKE-interrupt-stopping-state-20260623-075028.md`
- `adr/research/synthesis-interrupt-stopping-state-20260623-075028.md`
- `adr/specs/interrupt-stopping-state-20260623-075028.md`
- `adr/decisions/0044-model-interrupt-as-stop-request-metadata-20260623-075635.md`
