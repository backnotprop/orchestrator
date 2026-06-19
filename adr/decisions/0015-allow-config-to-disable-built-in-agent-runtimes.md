# 15. Allow config to disable built-in agent runtimes

Date: 2026-06-17

## Status

Accepted

## Context

Orchestrator has built-in agent runtimes such as `claude-code` and `codex`.
Those defaults are useful for a first release, but a user may not want every
built-in agent to be available in a given environment.

This matters for both the CLI and the future higher-level orchestrator agent.
If a user disables an agent, that agent should not appear as an available
choice. The system should behave as though that runtime is not installed for
that configured environment.

ADR 14 defines JSON config for custom sub-agent runtimes. The same config file
should also be able to control whether built-in runtimes are available.

## Decision

Allow JSON config to disable or re-enable built-in agent runtimes with an
`enabled` field.

Example:

```json
{
  "agents": {
    "claude-code": { "enabled": false },
    "codex": { "enabled": true }
  }
}
```

`enabled: false` means the runtime is not available in the configured registry:

- it does not appear in `orchestrator --help`;
- it does not appear in machine-readable help;
- it cannot be launched by runtime id;
- it should not be presented to future orchestrator-agent instructions as an
  available launch option.

`enabled: true` may re-enable a built-in runtime if an earlier config file
disabled it. This follows the existing config load order from ADR 14, where
later config sources can override earlier sources.

Custom agents are enabled by default. A custom agent may also use
`enabled: false` so a user can leave the config entry in place without making
it available.

This decision is only about agent availability. It does not require any broader
policy for replacing or redefining built-in runtime behavior.

## Consequences

Users can make their configured Orchestrator environment smaller and clearer.
For example, a team can expose only `codex`, only `claude-code`, or only their
own custom agents.

The runtime registry becomes the source of truth for what can be launched.
Higher-level tools should ask the configured registry what is available instead
of assuming every built-in runtime exists.

Task history remains readable even when the runtime used by an older task is
now disabled. Disabling an agent affects new launches and availability lists; it
does not delete stored tasks.

Tests should cover:

- disabling a built-in runtime;
- re-enabling a built-in runtime from a later config source;
- hiding disabled runtimes from CLI help and machine-readable help;
- failing cleanly when launching a disabled runtime;
- disabling a custom runtime.
