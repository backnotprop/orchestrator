# 0063. Discover Models From Runtime-Local Catalogs

Date: 2026-07-09

## Status

Accepted

## Context

The Orchestrator skill can route work by runtime and model, but static model
examples become stale as providers release and retire models. A calling agent
also cannot reliably know which models are available to the user's current
CLI, account, and authentication from its own training knowledge.

Provider discovery surfaces differ. Codex has a structured app-server method;
Grok and Pi print authenticated catalogs; Copilot publishes its installed
catalog through CLI help; Claude Code exposes aliases that follow the current
model in a family rather than an exact catalog.

A central Orchestrator model registry or release tracker would duplicate
provider state and require frequent maintenance.

## Decision

Add `orchestrator models [runtime] --json --compact` as the stable discovery
surface for agents.

Core owns small adapters for built-in runtimes and normalizes launchable model
ids, defaults, aliases, routers, capabilities, discovery source, CLI version,
and status. Codex uses `model/list`; other built-ins use their runtime-local CLI
surfaces. Incomplete catalogs report `partial`, unavailable discovery reports
`unavailable`, and unsupported custom runtimes report `unsupported` without
blocking peer discovery.

Orchestrator does not infer model recency from names and does not become a model
router. The skill omits `--model` when no override is required, validates exact
requests against live discovery, and resolves "latest" or "best" through a
returned default, alias, or router. Provider-native model values continue to
pass through unchanged.

## Consequences

The skill remains evergreen while provider-specific catalog mechanics can
change behind one command. Users can write preferences with human model names
without maintaining exact slugs themselves.

Human-readable provider output still requires localized parsers, so every
catalog reports its source and status. Claude Code remains intentionally
partial until it exposes an exact runtime catalog. Custom runtime discovery
configuration can be added later if real usage justifies a public adapter
contract.
