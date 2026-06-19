# 9. Keep core frontend independent with CLI TUI later

Date: 2026-06-17

## Status

Accepted

## Context

The desired user interface is eventually a CLI/TUI with strong background-task
visibility and control. A Pi extension could also be useful. Flue could be
useful later as a host/server/runtime wrapper.

But making any frontend the core would couple task supervision, launch
semantics, and state management to UI assumptions.

## Decision

Keep the orchestrator core frontend-independent.

The core owns:

- runtime registry and launch-plan builders;
- task store;
- process supervision;
- tool layer;
- events/logs/transcripts/results;
- capacity, cancellation, and isolation policy.

Frontends are clients of the same core. Possible frontends:

- simple CLI first;
- richer TUI later;
- optional Pi extension;
- optional HTTP API;
- optional Flue wrapper;
- optional local dashboard after the task/event model stabilizes.

## Consequences

This lets the core be tested without a full UI and keeps the eventual TUI from
owning architectural decisions.

The cost is that we need a clean core API early. That API should be shaped by
the same primitives the orchestrator brain uses: launch, list, wait, read,
events, interrupt, and message.
