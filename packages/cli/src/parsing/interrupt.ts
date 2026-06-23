import { unknownOptionError } from "../cli-errors.ts";
import { validateInterruptOptions, type InterruptOptions } from "../commands/interrupt.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, requireValue } from "./primitives.ts";

export function parseInterruptOptions(args: readonly string[]): InterruptOptions {
  const common = defaultCommonOptions();
  const taskIds: string[] = [];
  let parentId: string | undefined;
  let groupId: string | undefined;
  let active = false;
  let allWorkspaces = false;
  let children = false;
  let taskOnly = false;
  let yes = false;
  let reason: string | undefined;
  let signal: NodeJS.Signals | undefined;
  let compact = false;

  for (let index = 0; index < args.length; index += 1) {
    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    const arg = args[index];
    switch (arg) {
      case "--compact":
        compact = true;
        break;
      case "--parent":
        parentId = requireValue(args, ++index, arg);
        break;
      case "--group":
        groupId = requireValue(args, ++index, arg);
        break;
      case "--active":
        active = true;
        break;
      case "-A":
      case "--all-workspaces":
        allWorkspaces = true;
        break;
      case "--yes":
        yes = true;
        break;
      case "--children":
        children = true;
        break;
      case "--task-only":
        taskOnly = true;
        break;
      case "--reason":
        reason = requireValue(args, ++index, arg);
        break;
      case "--signal":
        signal = requireValue(args, ++index, arg) as NodeJS.Signals;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("interrupt", arg);
        }
        taskIds.push(arg);
    }
  }

  return validateInterruptOptions({
    ...common,
    taskIds,
    ...(parentId ? { parentId } : {}),
    ...(groupId ? { groupId } : {}),
    active,
    allWorkspaces,
    children,
    taskOnly,
    yes,
    ...(reason ? { reason } : {}),
    ...(signal ? { signal } : {}),
    compact,
  });
}
