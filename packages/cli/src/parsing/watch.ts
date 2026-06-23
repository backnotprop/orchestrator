import { unknownOptionError } from "../cli-errors.ts";
import type { WatchOptions } from "../commands/watch.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseIntegerOption, requireValue } from "./primitives.ts";
import { duplicateTaskIdError, missingTaskIdError } from "./task-id-errors.ts";

export function parseWatchOptions(args: readonly string[]): WatchOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let intervalMs = 250;
  let agentOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    const arg = args[index];
    switch (arg) {
      case "--agent-only":
        agentOnly = true;
        break;
      case "--interval-ms":
        intervalMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("watch", arg);
        }
        if (taskId) {
          throw duplicateTaskIdError("watch");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw missingTaskIdError("watch");
  }

  return {
    ...common,
    taskId,
    intervalMs,
    agentOnly,
  };
}
