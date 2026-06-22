# Custom Agents

Orchestrator can run agents beyond Claude Code and Codex.

A custom agent is a named agent you add to config, then start with
`orchestrator launch <name>`. After launch, the same commands work: `list`,
`watch`, `logs`, `read`, and `interrupt`.

Default config file:

```text
~/.orchestrator/config.json
```

<details>
<summary>Other Config Locations</summary>

Orchestrator also supports XDG and repo-local config. It checks files in this
order:

1. XDG config:
   `$XDG_CONFIG_HOME/orchestrator/config.json`, or
   `~/.config/orchestrator/config.json` when `XDG_CONFIG_HOME` is unset
2. Default global config: `~/.orchestrator/config.json`
3. Repo config: `<workspace>/orchestrator.config.json`
4. Repo-local config: `<workspace>/.orchestrator/config.json`
5. Explicit command config: `--config <path>`

</details>

Later files override earlier custom agents with the same name. Built-in names,
such as `claude-code` and `codex`, can be enabled or disabled.

The top-level `agents` object maps names to how each agent starts. The name is
what you pass to `orchestrator launch`.

## Disable Agents

Use `enabled: false` when an agent should not be available in this
environment.

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

Later config files can re-enable a built-in agent:

```json
{
  "agents": {
    "claude-code": { "enabled": true }
  }
}
```

## Process Agents

Process means local. Orchestrator starts a command on your machine, passes the
task prompt to it, captures output, and stores the run under `.orchestrator/`.

```json
{
  "agents": {
    "reviewer": {
      "adapter": "process",
      "command": "reviewer-agent",
      "args": ["run", "--prompt", "{prompt}"],
      "output": "text"
    }
  }
}
```

Once configured, the custom agent launches like Claude Code or Codex:

```sh
orchestrator launch reviewer --name "review api" "Review the API package."
orchestrator watch <task-id|prefix>
orchestrator read <task-id|prefix>
```

The CLI only needs the name, `reviewer`. The adapter details stay in config.

## Schema

V1 fields:

- `adapter`: must be `process`
- `enabled`: optional; defaults to `true`
- `command`: executable name or path
- `args`: argv array; use `{prompt}` where the task should go
- `prompt`: optional fallback when no `{prompt}` placeholder is present;
  accepts `argv-last`, `argv-first`, or `stdin`
- `output`: `text`, `json`, or `{ "format": "jsonl", "finalEvent": "done" }`
- `modelFlag`: optional flag for passing `--model <value>`
- `env`: small static environment values
- `timeoutMs`: optional timeout override
- `maxOutputBytes`: optional output cap override

Do not use shell command strings here. If a custom agent is a script, expose it
as an executable and pass arguments as an array.

Only literal `{prompt}` and `{model}` placeholders are replaced. Do not use
`{task}`, `{{prompt}}`, or `{{model}}`. JavaScript or shell template text such
as `${prompt}` is left alone inside wrapper code.

## Token Usage

Custom agents do not need to report token usage. If they do not, Orchestrator
shows usage as unknown.

Agents that use JSONL output can opt in by emitting normalized usage events:

```jsonl
{"type":"usage","usage":{"inputTokens":1200,"outputTokens":300,"totalTokens":1500,"source":"provider","scope":"task","final":false}}
{"type":"final","text":"Done.","usage":{"inputTokens":1200,"outputTokens":350,"totalTokens":1550,"source":"provider","scope":"task","final":true}}
```

JSONL agents must emit valid JSON lines and a final result event. Malformed
JSONL without a final result is treated as a failed task so callers do not
mistake raw broken output for a successful answer.

Use `source` to say where the numbers came from:

- `provider`: reported by the underlying model provider
- `runtime`: calculated by the custom agent runtime
- `estimated`: local estimate; useful for context pressure, not billing

Use `scope` to say what the numbers describe:

- `turn`: one model response or turn
- `task`: the whole launched task
- `session`: cumulative runtime session usage
- `account`: account or quota usage, not task spend

Orchestrator keeps the latest best task-level usage summary. A final task usage
event will not be overwritten by later session, account, or estimated usage.

## Flue Example

Agents built with [Flue](https://github.com/withastro/flue) can be registered
the same way if they expose a headless command.

For example, a small wrapper script could take one prompt argument and call a
Flue agent or workflow internally:

```json
{
  "agents": {
    "flue-triage": {
      "adapter": "process",
      "command": "flue-triage",
      "args": ["--prompt", "{prompt}"],
      "output": "text"
    }
  }
}
```

Usage:

```sh
orchestrator launch flue-triage --name "triage bug" "Triage this bug report."
```

If the wrapper can access Flue `PromptUsage`, map it before emitting JSONL:

- `input` -> `inputTokens`
- `output` -> `outputTokens`
- `cacheRead` -> `cacheReadTokens`
- `cacheWrite` -> `cacheWriteTokens`
- `totalTokens` -> `totalTokens`
- `cost.total` -> `costUsd` only when the unit is USD

If a Flue app is running as a service, it should fit the future `http` adapter
instead. That is the path for remote agents.

```json
{
  "agents": {
    "remote-triage": {
      "adapter": "http",
      "url": "https://agents.example.com/triage",
      "method": "POST",
      "body": {
        "task": "{prompt}",
        "taskId": "{taskId}",
        "model": "{model}"
      }
    }
  }
}
```

The `http` adapter should be async-first: remote agents should be able to return
status, events, result, and cancel URLs when they support long-running work.

## Design Rule

Custom agent names are open-ended. Adapter values are not.

Most custom agents should work through:

```json
{ "adapter": "process" }
```

Remote agents should eventually work through:

```json
{ "adapter": "http" }
```

Dedicated framework adapters should only be added when `process` or `http`
cannot represent the framework's real lifecycle cleanly.
