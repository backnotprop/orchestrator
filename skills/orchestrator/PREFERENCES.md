# Orchestrator Preferences

Preferences are optional. Replace `No preferences set.` with plain-language
instructions for choosing agents, models, fallbacks, and limit behavior.

The current user request always wins. The skill still checks live runtime
availability and provider limits before applying a preference.

<!--
Example:

Use Fable only for extensive UI work.
Use GPT-5.6 Sol for most deep execution work.
Use Grok 4.5 Agent for simple coding tasks.
Use Pi with Kimi 2.7 for exploration.
When Fable is out of usage, use GPT-5.6.
When GPT-5.6 is out of usage, use Opus.
When every allowed provider is out of usage, pause new work until limits reset
and notify me.
-->

## User Preferences

No preferences set.
