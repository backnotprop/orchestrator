import { resolve } from "node:path";
import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { DoctorOptions } from "../commands/doctor.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, requireValue } from "./primitives.ts";

export function parseDoctorOptions(args: readonly string[]): DoctorOptions {
  const common = defaultCommonOptions();
  let agentDir: string | undefined;
  let sessionDir: string | undefined;
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
      case "--agent-dir":
        agentDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--session-dir":
        sessionDir = resolve(requireValue(args, ++index, arg));
        break;
      default:
        throw unknownOptionError("doctor", String(arg));
    }
  }

  if (compact && !common.json) {
    throw new CliError("doctor --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use doctor --json --compact, or omit --compact.",
    });
  }

  return {
    ...common,
    ...(agentDir ? { agentDir } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    compact,
  };
}
