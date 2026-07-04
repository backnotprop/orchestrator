import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { GoalStartOptions } from "../commands/goal.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseIntegerOption, requireValue } from "./primitives.ts";
import { requireJsonForCompact } from "./validation.ts";

export function parseGoalOptions(args: readonly string[]): GoalStartOptions {
  const [subcommand, ...rest] = args;
  if (subcommand !== "start") {
    throw new CliError("goal requires a subcommand.", {
      reason: "missing_required_argument",
      input: subcommand,
      hint: 'Use goal start <task-id|prefix> "goal".',
    });
  }
  return parseGoalStartOptions(rest);
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
    taskId,
    goal,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    wait,
    compact,
  };
}
