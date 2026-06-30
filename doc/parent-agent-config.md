# Parent Agent Config

`orchestrator run` starts Orchestrator as an AI agent. That parent agent uses
Pi packages for provider auth, model discovery, sessions, and model calls.

This config is only for the parent agent. Agent runtimes launched with
`orchestrator launch` are configured separately in
[custom-agents.md](custom-agents.md).

## Default Files

Orchestrator uses its own config directory by default:

```text
~/.orchestrator/auth.json
~/.orchestrator/models.json
~/.orchestrator/sessions/
```

Check the setup before running:

```sh
orchestrator doctor
```

Run the parent agent:

```sh
orchestrator run "Figure out what needs to change in this repo."
```

## Auth

`auth.json` uses Pi's auth format. Prefer environment references so secrets do
not live directly in the file:

```json
{
  "openai": {
    "type": "api_key",
    "key": "$OPENAI_API_KEY"
  },
  "anthropic": {
    "type": "api_key",
    "key": "$ANTHROPIC_API_KEY"
  }
}
```

The important field is `key`, not `apiKey`.

Pi also supports literal keys and command-backed keys:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!op read 'op://vault/anthropic/api-key'"
  }
}
```

## Models

`models.json` is optional. Omit it if built-in Pi models are enough.

If you create the file, keep it schema-valid. The smallest valid file is:

```json
{
  "providers": {}
}
```

Custom providers and local models also use Pi's model config shape:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "qwen2.5-coder:7b"
        }
      ]
    }
  }
}
```

The CLI does not expose `orchestrator run --model` yet. It uses Pi's available
authenticated models and restores the saved model for an existing parent
session when possible.

## Existing Pi Config

Orchestrator does not read `~/.pi/agent` by default. For a live test, point the
parent agent at an existing Pi config directory explicitly:

```sh
orchestrator doctor --agent-dir ~/.pi/agent
```

```sh
orchestrator run --agent-dir ~/.pi/agent "Review this repo."
```

You can keep auth/model config in one directory and sessions somewhere else:

```sh
orchestrator run \
  --agent-dir ~/.pi/agent \
  --session-dir ~/.orchestrator/sessions \
  "Review this repo."
```

## Live Smoke Test

The parent-run smoke test uses a real parent agent, starts a background
Orchestrator run, launches one shell child, waits for the result, and checks
`read`, `events`, `watch`, and `ps` output.

It is skipped by default because it makes a real model call:

```sh
RUN_PARENT_RUN_SMOKE=1 node --experimental-strip-types --test test/parent-run-smoke.test.ts
```

By default it uses `~/.pi/agent`. Override that path when needed:

```sh
RUN_PARENT_RUN_SMOKE=1 \
PARENT_RUN_SMOKE_AGENT_DIR=/path/to/agent-config \
node --experimental-strip-types --test test/parent-run-smoke.test.ts
```

## Doctor Output

`doctor` checks the parent-agent config directory, auth file, model config,
session path, and whether configured models can be found.

Missing config is a warning so setup can be guided before the parent agent is
ready. Malformed config is an error.

Use JSON output for scripts:

```sh
orchestrator doctor --json
```
