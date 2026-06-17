# 14. Use JSON config for custom sub-agent runtimes

Date: 2026-06-17

## Status

Accepted

## Context

The runtime architecture already supports more than the built-in Claude Code and
Codex runtimes. A runtime is defined by how the orchestrator can start or call a
worker, pass it task instructions, observe progress, collect a result, and stop
the work when possible.

That internal shape is useful for code, but it is too detailed for users who
just want to register a custom sub-agent that Orchestrator can launch as a
worker.

We need a simple developer experience for custom sub-agents without exposing
the entire internal runtime registry. The config should be easy for humans to
read, easy for agents to generate, and easy for the CLI to validate.

YAML is convenient for hand-written config, but it adds parser ambiguity and an
extra dependency surface. JSON is stricter, easier to validate with JSON Schema,
and easier for agents and tooling to produce consistently.

The config language also needs clear names. A user-defined sub-agent id should
be arbitrary. The field that describes how to run that sub-agent should not be
called `type`, because that sounds like the user's agent category. Use
`adapter` for the small set of orchestrator-supported execution mechanisms.

## Decision

Use JSON as the first user-facing custom sub-agent configuration format.

The default global file is:

```text
~/.orchestrator/config.json
```

Also support XDG-style config for users who avoid home dot directories:

```text
$XDG_CONFIG_HOME/orchestrator/config.json
~/.config/orchestrator/config.json
```

Also support repo-local config:

```text
<workspace>/orchestrator.config.json
<workspace>/.orchestrator/config.json
```

CLI commands may accept an explicit extra config file:

```sh
orchestrator launch <runtime> --config <path> "Do the work."
```

Load config in this order:

1. XDG config: `$XDG_CONFIG_HOME/orchestrator/config.json`, or
   `~/.config/orchestrator/config.json` when `XDG_CONFIG_HOME` is unset;
2. home dot config;
3. workspace `orchestrator.config.json`;
4. workspace `.orchestrator/config.json`;
5. explicit `--config <path>`.

Later custom runtime ids override earlier custom runtime ids. Built-in runtime
ids cannot be overridden.

The public config is intentionally smaller than the internal runtime config.
Users define named sub-agent runtimes under `agents`.

The object keys under `agents` are arbitrary runtime ids. These are the names
the CLI and future higher-level agent can launch.

V1 supports one custom adapter:

```text
process
```

`adapter: "process"` runs a local command, passes the task prompt through argv,
stdin, or a prompt file, captures stdout/stderr, and tracks the worker through
the normal task store.

Example:

```json
{
  "agents": {
    "my-reviewer": {
      "adapter": "process",
      "command": "my-reviewer",
      "args": ["run", "--model", "{model}", "--prompt", "{prompt}"],
      "output": "text"
    },
    "local-agent": {
      "adapter": "process",
      "command": "local-agent",
      "args": ["run", "--json"],
      "prompt": "stdin",
      "output": {
        "format": "jsonl",
        "finalEvent": "done"
      }
    }
  }
}
```

After loading config, custom sub-agents should work like built-ins:

```sh
orchestrator launch my-reviewer --model small "Review this repo."
orchestrator launch local-agent "Do the task."
```

Orchestrator should expose launchable runtime ids, not adapter details:

```text
claude-code
codex
my-reviewer
local-agent
```

The likely next custom adapter is:

```text
http
```

`adapter: "http"` means a remote sub-agent. This should be designed
async-first because remote agents may run for a long time.

Target shape:

```json
{
  "agents": {
    "remote-triage": {
      "adapter": "http",
      "url": "https://agents.example.com/triage",
      "method": "POST",
      "headers": {
        "Authorization": "Bearer ${TRIAGE_AGENT_TOKEN}"
      },
      "body": {
        "task": "{prompt}",
        "taskId": "{taskId}",
        "model": "{model}"
      },
      "resultPath": "result.text"
    }
  }
}
```

The stronger async HTTP form should let a remote service return task controls:

```json
{
  "remoteTaskId": "remote-123",
  "statusUrl": "https://agents.example.com/tasks/remote-123",
  "eventsUrl": "https://agents.example.com/tasks/remote-123/events",
  "resultUrl": "https://agents.example.com/tasks/remote-123/result",
  "cancelUrl": "https://agents.example.com/tasks/remote-123"
}
```

The orchestrator should map that remote lifecycle back into its own task model:

- local task id;
- remote task id when provided;
- running/completed/failed/cancelled status;
- normalized events when available;
- raw request/response logs where safe;
- final result;
- cancellation if the remote service exposes it.

Synchronous HTTP, where the POST stays open until a result is returned, may be
supported as a weaker mode. It is useful for short work, but it is not the
preferred shape for background agents.

The V1 public config should support:

- `adapter`: required adapter mechanism; V1 accepts `process`;
- `command`: executable name or path for `process`;
- `args`: argv array for `process`, never a shell string;
- `{prompt}` placeholder for explicit prompt placement;
- `{model}` placeholder or `modelFlag` for model selection;
- `prompt`: optional prompt delivery mode when no `{prompt}` placeholder is
  used;
- `output`: `text`, `json`, or an object such as
  `{ "format": "jsonl", "finalEvent": "done" }` when needed;
- `timeoutMs` and `maxOutputBytes` overrides;
- small static `env` values when needed.

Defaults should keep the common case small:

- prompt defaults to appending the task as the last argv value;
- output defaults to text;
- interrupt defaults to process-group cleanup;
- cwd defaults to the selected workspace;
- custom sub-agents are observable through the same task store, logs, events,
  transcript, result, and interrupt paths as built-in runtimes.

Do not expose the full internal `HeadlessAgentRuntimeConfig` as the public
configuration contract.

Do not accept raw shell command strings for custom sub-agents. If shell
execution is needed, it must go through the explicitly disabled and allowlisted
shell runtime, not through custom sub-agent config.

Do not hard-code framework names into V1 custom config. A Flue-built agent,
LangGraph agent, local script, or any other framework-built worker should first
work through `adapter: "process"` if it exposes a headless command. Remote
framework agents should fit the future `adapter: "http"` shape. Dedicated
framework adapters are allowed later only when process/http cannot express the
real lifecycle ergonomically.

Do not require structured worker output. Plain text remains the simplest and
most compatible default.

## Consequences

This gives users a clear way to add custom sub-agents without waiting for new
built-in runtime adapters.

JSON makes the config easy to validate, easy to document, and easy for other
agents to write. It also keeps dependency weight low because Node can parse JSON
without adding YAML parsing.

The cost is that JSON is less forgiving for hand-written comments and trailing
commas. We accept that because correctness, schema validation, and generated
config matter more for this surface.

The `adapter` name keeps the schema stable:

- user-defined agent ids stay arbitrary;
- adapter values stay limited to mechanisms the orchestrator knows how to run;
- V1 stays small with `process`;
- remote agents have a clear future path through async-first `http`.

Complex integrations may still require built-in runtime adapters. The config
format should keep those integrations ergonomic without making V1 pretend to
support every SDK, IPC protocol, or framework-specific lifecycle.

References:

- [Use typed runtime registry and pure launch plan builders](0005-use-typed-runtime-registry-and-pure-launch-plan-builders.md)
- [Launch external agents through headless runtime adapters](0007-launch-external-agents-through-headless-runtime-adapters.md)
- [Scope first release to Claude Code and Codex runtimes](0012-scope-first-release-to-claude-code-and-codex-runtimes.md)
