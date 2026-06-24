# Service and Slack Interface Backlog

Date: 2026-06-23

## Status

Backlog idea.

## Intent

Explore running Orchestrator as a long-lived service that other interfaces can
talk to, including Slack. The goal is to keep the current core as the source of
truth while allowing non-CLI clients to launch, inspect, and stop agents.

## Product Shape

The shape should be:

```txt
Slack or another client
  -> adapter
    -> Orchestrator service API
      -> Orchestrator core
        -> Claude Code / Codex / custom agents
```

Slack should not become Orchestrator. It should be one client over the same
task system used by the CLI, parent agent, skill/plugin, and future TUI.

## What Exists Already

- runtime registry and launch plans
- machine-level task store
- background process supervisor
- parent/child task metadata
- logs, events, final output, and usage
- interruption and group control
- compact `ps` control view
- parent-agent tools for launching and reading child agents
- machine-friendly JSON output

## Future Work

1. Add an Orchestrator service package.
   - Possible package: `packages/server`.
   - Expose task and run APIs over HTTP.
   - Keep the service as a thin layer over core operations.

2. Add live event delivery.
   - Use SSE or WebSocket for task/run updates.
   - Reuse existing task events and run events.
   - Do not invent a second event model for Slack.

3. Add a Slack adapter.
   - Map Slack messages, threads, and slash commands to service API calls.
   - Example commands:

     ```txt
     @orchestrator launch codex to review this PR
     @orchestrator status
     @orchestrator stop 8f13c2a
     ```

   - Post status updates and final answers back into the Slack thread.

4. Add identity and workspace mapping.
   - Map Slack users to allowed workspaces and runtimes.
   - Decide which repos the service can access.
   - Decide which provider credentials are available.
   - Decide whether custom runtimes are allowed per workspace.

5. Start single-node.
   - Use the current file-backed task store first.
   - Require Claude Code, Codex, and custom agent CLIs to be installed on the
     service host.
   - Add a database only when the file store becomes the bottleneck.

## Candidate API

```txt
POST /runs
POST /tasks
GET  /tasks
GET  /tasks/:id
GET  /tasks/:id/events
GET  /tasks/:id/logs
POST /tasks/:id/interrupt
```

The exact API should be designed from existing core operations, not from Slack's
needs alone.

## Non-Goals For The First Slice

- No distributed queue.
- No Kubernetes requirement.
- No multi-node scheduler.
- No separate Slack-only task model.
- No database migration unless required by the first service prototype.

## Open Questions

- Should the service run one global machine-level store or support named stores?
- How should provider credentials be configured for a service process?
- How should Slack threads map to Orchestrator parent runs?
- What permissions are required before launching agents against a workspace?
- What retention policy should logs and events use?

## First Useful Slice

Build a local service MVP:

1. `orchestrator server`
2. HTTP task/run endpoints over existing core APIs
3. SSE stream for live task updates
4. no Slack yet
5. a tiny local client smoke test

Once that works, Slack becomes an adapter over a real service instead of a one-off
bot wrapped around CLI commands.
