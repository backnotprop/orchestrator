import type { TaskStatus } from "@backnotprop/orchestrator-core";
import { unknownOptionError } from "../cli-errors.ts";
import type { ListOptions } from "../commands/list.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseTaskStatus, requireValue } from "./primitives.ts";

export function parseListOptions(args: readonly string[]): ListOptions {
  const common = defaultCommonOptions();
  let status: TaskStatus | undefined;
  let allWorkspaces = false;

  for (let index = 0; index < args.length; index += 1) {
    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    const arg = args[index];
    switch (arg) {
      case "--status":
        status = parseTaskStatus(requireValue(args, ++index, arg), arg);
        break;
      case "-A":
      case "--all-workspaces":
        allWorkspaces = true;
        break;
      default:
        throw unknownOptionError("list", String(arg));
    }
  }

  return {
    ...common,
    ...(status ? { status } : {}),
    allWorkspaces,
  };
}
