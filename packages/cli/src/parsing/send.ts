import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { SendOptions } from "../commands/send.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseIntegerOption, requireValue } from "./primitives.ts";
import { requireJsonForCompact } from "./validation.ts";

export function parseSendOptions(args: readonly string[]): SendOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  const messageParts: string[] = [];
  let timeoutMs: number | undefined;
  let compact = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      messageParts.push(...args.slice(index + 1));
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
      case "--compact":
        compact = true;
        break;
      default:
        if (!arg) {
          break;
        }
        if (arg.startsWith("-")) {
          throw unknownOptionError("send", arg);
        }
        messageParts.push(arg);
    }
  }

  if (!taskId) {
    throw new CliError("send requires a task id.", {
      reason: "missing_required_argument",
      input: "task-id",
      hint: 'Use send <task-id|prefix> "message".',
    });
  }
  const message = messageParts.join(" ").trim();
  if (!message) {
    throw new CliError("send requires a message.", {
      reason: "missing_required_argument",
      input: "message",
      hint: 'Use send <task-id|prefix> "message".',
    });
  }
  requireJsonForCompact("send", compact, common.json);

  return {
    ...common,
    taskId,
    message,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    compact,
  };
}
