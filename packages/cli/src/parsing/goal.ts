import { CliError, unknownOptionError } from "../cli-errors.ts";
import type {
  GoalClearOptions,
  GoalGetOptions,
  GoalOptions,
  GoalSetOptions,
  GoalStartOptions,
} from "../commands/goal.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseIntegerOption, requireValue } from "./primitives.ts";
import { requireJsonForCompact } from "./validation.ts";

export function parseGoalOptions(args: readonly string[]): GoalOptions {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "start":
      return parseGoalStartOptions(rest);
    case "get":
      return parseGoalGetOptions(rest);
    case "set":
      return parseGoalSetOptions(rest);
    case "clear":
      return parseGoalClearOptions(rest);
    default:
      throw new CliError("goal requires a subcommand.", {
        reason: "missing_required_argument",
        input: subcommand,
        hint: "Use goal start|get|set|clear. Example: goal get <task-id|prefix> --json.",
      });
  }
}

function parseGoalStartOptions(args: readonly string[]): GoalStartOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  const goalParts: string[] = [];
  let timeoutMs: number | undefined;
  let tokenBudget: number | undefined;
  let compact = false;
  let wait = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      goalParts.push(...args.slice(index + 1));
      break;
    }

    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    if (!taskId && arg && !arg.startsWith("-")) {
      taskId = arg;
      continue;
    }

    switch (arg) {
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--token-budget":
        tokenBudget = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--wait":
        wait = true;
        break;
      case "--compact":
        compact = true;
        break;
      default:
        if (!arg) {
          break;
        }
        if (arg.startsWith("-")) {
          throw unknownOptionError("goal start", arg);
        }
        goalParts.push(arg);
    }
  }

  if (!taskId) {
    throw new CliError("goal start requires a task id.", {
      reason: "missing_required_argument",
      input: "task-id",
      hint: 'Use goal start <task-id|prefix> "goal".',
    });
  }
  const goal = goalParts.join(" ").trim();
  if (!goal) {
    throw new CliError("goal start requires a goal.", {
      reason: "missing_required_argument",
      input: "goal",
      hint: 'Use goal start <task-id|prefix> "goal".',
    });
  }
  requireJsonForCompact("goal start", compact, common.json);

  return {
    ...common,
    command: "start",
    taskId,
    goal,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    wait,
    compact,
  };
}

function parseGoalGetOptions(args: readonly string[]): GoalGetOptions {
  const parsed = parseGoalControlBaseOptions("goal get", args);
  return {
    ...parsed.common,
    command: "get",
    taskId: parsed.taskId,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    compact: parsed.compact,
  };
}

function parseGoalClearOptions(args: readonly string[]): GoalClearOptions {
  const parsed = parseGoalControlBaseOptions("goal clear", args);
  return {
    ...parsed.common,
    command: "clear",
    taskId: parsed.taskId,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    compact: parsed.compact,
  };
}

function parseGoalSetOptions(args: readonly string[]): GoalSetOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let timeoutMs: number | undefined;
  let compact = false;
  let objective: string | undefined;
  let status: GoalSetOptions["status"];
  let tokenBudget: number | null | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    if (!taskId && arg && !arg.startsWith("-")) {
      taskId = arg;
      continue;
    }

    switch (arg) {
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--objective":
        objective = requireValue(args, ++index, arg).trim();
        break;
      case "--status":
        status = parseGoalSetStatus(requireValue(args, ++index, arg));
        break;
      case "--token-budget": {
        const raw = requireValue(args, ++index, arg);
        tokenBudget = raw === "none" ? null : parseIntegerOption(raw, arg);
        break;
      }
      case "--compact":
        compact = true;
        break;
      default:
        if (!arg) {
          break;
        }
        throw unknownOptionError("goal set", arg);
    }
  }

  if (!taskId) {
    throw new CliError("goal set requires a task id.", {
      reason: "missing_required_argument",
      input: "task-id",
      hint: "Use goal set <task-id|prefix> --status paused.",
    });
  }
  if (!objective && status === undefined && tokenBudget === undefined) {
    throw new CliError("goal set requires a change.", {
      reason: "missing_required_argument",
      input: "goal",
      hint: "Pass --objective, --status, or --token-budget.",
    });
  }
  requireJsonForCompact("goal set", compact, common.json);

  return {
    ...common,
    command: "set",
    taskId,
    ...(objective ? { objective } : {}),
    ...(status ? { status } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    compact,
  };
}

function parseGoalControlBaseOptions(command: string, args: readonly string[]) {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let timeoutMs: number | undefined;
  let compact = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    if (!taskId && arg && !arg.startsWith("-")) {
      taskId = arg;
      continue;
    }

    switch (arg) {
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--compact":
        compact = true;
        break;
      default:
        if (!arg) {
          break;
        }
        throw unknownOptionError(command, arg);
    }
  }

  if (!taskId) {
    throw new CliError(`${command} requires a task id.`, {
      reason: "missing_required_argument",
      input: "task-id",
      hint: `Use ${command} <task-id|prefix>.`,
    });
  }
  requireJsonForCompact(command, compact, common.json);

  return {
    common,
    taskId,
    timeoutMs,
    compact,
  };
}

function parseGoalSetStatus(value: string): GoalSetOptions["status"] {
  switch (value) {
    case "paused":
    case "blocked":
    case "complete":
      return value;
    case "usage-limited":
    case "usage_limited":
      return "usage_limited";
    case "budget-limited":
    case "budget_limited":
      return "budget_limited";
    case "active":
      throw new CliError("goal set cannot activate a goal.", {
        reason: "invalid_request",
        input: value,
        hint: "Use goal start when activating a goal so Orchestrator can track the work.",
      });
    default:
      throw new CliError(`Unknown goal status "${value}".`, {
        reason: "invalid_request",
        input: value,
        hint: "Use paused, blocked, usage-limited, budget-limited, or complete.",
      });
  }
}
