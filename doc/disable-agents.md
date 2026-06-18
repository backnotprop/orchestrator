# Disable Agents

Use config when an agent should not be available in an Orchestrator
environment.

Default config file:

```text
~/.orchestrator/config.json
```

Example:

```json
{
  "agents": {
    "claude-code": { "enabled": false },
    "codex": { "enabled": true }
  }
}
```

Disabled agents are hidden from `orchestrator --help`, hidden from
`orchestrator help --json`, and cannot be launched.

Later config files can re-enable a built-in runtime:

```json
{
  "agents": {
    "claude-code": { "enabled": true }
  }
}
```

Disabling an agent affects new launches only. Existing task history remains
readable.
