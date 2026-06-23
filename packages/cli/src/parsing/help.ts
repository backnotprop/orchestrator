import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { HelpOptions } from "../commands/help.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions } from "./primitives.ts";

export function parseHelpOptions(args: readonly string[]): HelpOptions {
  const common = defaultCommonOptions();
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
      default:
        throw unknownOptionError("help", String(arg));
    }
  }

  if (compact && !common.json) {
    throw new CliError("help --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use help --json --compact, or omit --compact.",
    });
  }

  return {
    workspaceRoot: common.workspaceRoot,
    ...(common.configPath ? { configPath: common.configPath } : {}),
    json: common.json,
    compact,
  };
}
