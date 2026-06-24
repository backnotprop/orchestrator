# Research Spike: Codex Exec Goal Support

Date: 2026-06-23

## Question

Does a command or prompt run through Codex `exec` respect `/goal`?

Put another way: can Orchestrator run a Codex goal by launching something like
`codex exec "/goal do this long-running objective"`?

## Short Answer

No. `codex exec` does not parse `/goal` as a slash command.

In `codex exec`, the prompt is converted into normal `UserInput::Text` and sent
through `turn/start`. A leading `/goal` is just model-visible text.

Codex goals are real, but they are not created by the `exec` prompt path. They
are created through the TUI slash-command path, which dispatches `/goal` into
app-server goal RPCs such as `thread/goal/set`, `thread/goal/get`, and
`thread/goal/clear`.

## What `codex exec` Does

The `exec` CLI accepts an optional `PROMPT`; there is no goal flag or goal
subcommand in the CLI shape.

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/exec/src/cli.rs`
  - `Cli.prompt` is plain "Initial instructions for the agent."
  - `Command` is `resume` or `review`; no `goal`.

The exec runner then builds a normal user turn:

- `/Users/ramos/oss-agents/codex/codex-rs/exec/src/lib.rs`
  - `resolve_root_prompt(...)` only resolves argv/stdin text.
  - the prompt becomes `UserInput::Text { text: prompt_text, ... }`.
  - exec starts or resumes a thread.
  - exec sends `ClientRequest::TurnStart` with that input.

There is no slash-command parser in this path and no
`ClientRequest::ThreadGoalSet`.

## What `/goal` Does In The TUI

The TUI has a slash-command registry. `/goal` is explicitly described as "set
or view the goal for a long-running task" and supports inline args.

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/tui/src/slash_command.rs`

When the TUI sees `/goal ...`, it does not submit that text as a normal model
prompt. It dispatches app events:

- `/goal clear` -> `ClearThreadGoal`
- `/goal pause` -> `SetThreadGoalStatus(Paused)`
- `/goal resume` -> `SetThreadGoalStatus(Active)`
- `/goal <objective>` -> `SetThreadGoalDraft`

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/tui/src/chatwidget/slash_dispatch.rs`

Those app events call the app-server goal APIs:

- `thread_goal_get(...)`
- `thread_goal_set(...)`
- `thread_goal_clear(...)`

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/tui/src/app/thread_goal_actions.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/tui/src/app_server_session.rs`

## The Programmatic Goal API Exists

Codex app-server protocol has explicit goal methods:

- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/thread_goal_processor.rs`

The app-server goal processor requires:

- goals feature enabled;
- a valid thread id;
- a materialized thread with state DB support.

Ephemeral threads do not support goals.

## Goal Runtime Behavior

After a goal exists, Codex has runtime machinery for it:

- the goal extension is installed when a state DB exists and the feature is
  enabled;
- active goal state can be restored after resume;
- idle active goals can trigger continuation;
- goal steering is injected as internal model context.

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/extensions.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/runtime.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/steering.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/ext/goal/src/extension.rs`

This means goals are not just UI text. They are persisted thread state with
runtime effects. But the missing piece is still: `codex exec` does not expose a
way to create or mutate that goal state.

## TypeScript SDK Surface

The TypeScript SDK currently wraps:

```text
codex exec --experimental-json
```

It can pass `input`, model options, cwd, sandbox options, and an optional
`threadId` for resume. It does not expose goal methods or goal args.

Evidence:

- `/Users/ramos/oss-agents/codex/sdk/typescript/src/exec.ts`
- `/Users/ramos/oss-agents/codex/sdk/typescript/src/thread.ts`

So the public SDK path has the same limitation as `codex exec`.

## `command/exec` Is Different

Codex also has an app-server method named `command/exec`. That is not
`codex exec`. It runs local shell/process commands through the app-server.

It does not parse `/goal` either. A command like `/goal ...` would be treated as
a shell command, not a Codex slash command.

Evidence:

- `/Users/ramos/oss-agents/codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `/Users/ramos/oss-agents/codex/codex-rs/app-server/src/request_processors/command_exec_processor.rs`

## Practical Implication For Orchestrator

Do not model "Codex goal support" as:

```text
codex exec "/goal ..."
```

That would be unreliable because it is just a prompt.

If Orchestrator wants to use native Codex goals later, the clean options are:

1. Add or use a Codex app-server client that can call `thread/goal/set`,
   `thread/goal/get`, and `thread/goal/clear`.
2. Ask upstream Codex for a non-interactive goal surface, such as
   `codex exec --goal "<objective>" ...`.
3. Resume a thread that already has a goal set, then use `codex exec resume
<thread-id> ...` only for follow-up turns. This may preserve existing goal
   state, but it does not create the goal.

For our current Orchestrator runtime, keep launching Codex through the normal
headless `exec` adapter. Treat goals as unsupported unless we explicitly build
against Codex's app-server goal APIs.

## Conclusion

`/goal` is a TUI slash command and app-server goal RPC workflow. `codex exec` is
a non-interactive prompt runner. A prompt passed to `exec` does not go through
the slash-command dispatcher, so it does not create a Codex goal.
