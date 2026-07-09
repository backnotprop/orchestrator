import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { ModelsOptions } from "../commands/models.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseIntegerOption, requireValue } from "./primitives.ts";
import { DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS } from "@backnotprop/orchestrator-core/model-discovery";

export function parseModelsOptions(args: readonly string[]): ModelsOptions {
  const common = defaultCommonOptions();
  let runtimeId: string | undefined;
  let compact = false;
  let timeoutMs = DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;

  for (let index = 0; index < args.length; index += 1) {
    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    const arg = String(args[index]);
    switch (arg) {
      case "--compact":
        compact = true;
        break;
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        if (arg.startsWith("-")) {
          throw unknownOptionError("models", arg);
        }
        if (runtimeId) {
          throw new CliError("models accepts at most one runtime id.", {
            reason: "unexpected_argument",
            input: arg,
            hint: "Use orchestrator models [runtime] --json --compact.",
          });
        }
        runtimeId = arg;
    }
  }

  if (compact && !common.json) {
    throw new CliError("models --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use models --json --compact, or omit --compact.",
    });
  }

  return {
    ...common,
    ...(runtimeId ? { runtimeId } : {}),
    compact,
    timeoutMs,
  };
}
