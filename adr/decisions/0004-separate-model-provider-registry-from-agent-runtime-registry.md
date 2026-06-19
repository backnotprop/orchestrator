# 4. Separate model provider registry from agent runtime registry

Date: 2026-06-17

## Status

Accepted

## Context

There are two different kinds of "things we support":

- model providers the orchestrator brain can call, such as OpenAI, Anthropic,
  Google, or local providers;
- headless agent runtimes the orchestrator can launch, such as Codex, Claude
  Code, Pi-as-worker, shell/custom commands, and future agents.

Calling Codex or Claude Code "providers" in the launch layer creates confusion.
They are agent runtimes. Each runtime may call a model provider internally, but
that is adapter-owned behavior.

## Decision

Maintain two separate registries:

1. Model/provider registry: used by the orchestrator brain for its own model
   calls, preferably reused from Pi.
2. Agent runtime registry: owned by the orchestrator and used to define what
   external headless agents can be launched and how.

The public `launch_agent` API should use `runtime`, not `provider`, for the
launch target.

## Consequences

This gives us clearer API names and cleaner boundaries:

- `model` remains an optional model hint or override;
- `runtime` names the external agent process/service to launch;
- model-provider policy stays with the orchestrator brain;
- runtime-specific flags, auth/session quirks, output transport, and result
  extraction stay behind runtime adapters.

This prevents the launch layer from turning into a confused mix of model
vendors, CLIs, SDKs, and pre-baked worker catalogs.
