import {
  DEFAULT_PROVIDER_LIMIT_TIMEOUT_MS,
  isBuiltInProviderLimitProvider,
  type BuiltInProviderLimitProvider,
} from "@backnotprop/orchestrator-core/provider-limits";
import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { LimitsOptions } from "../commands/limits.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseIntegerOption, requireValue } from "./primitives.ts";

export function parseLimitsOptions(args: readonly string[]): LimitsOptions {
  const common = defaultCommonOptions();
  let provider: BuiltInProviderLimitProvider | undefined;
  let compact = false;
  let timeoutMs = DEFAULT_PROVIDER_LIMIT_TIMEOUT_MS;

  for (let index = 0; index < args.length; index += 1) {
    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    const arg = args[index];
    switch (arg) {
      case "--provider":
        if (provider) {
          throw new CliError("limits --provider was provided more than once.", {
            reason: "duplicate_option",
            input: "--provider",
          });
        }
        provider = parseProviderLimitProvider(requireValue(args, ++index, arg));
        break;
      case "--compact":
        compact = true;
        break;
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        throw unknownOptionError("limits", String(arg));
    }
  }

  if (compact && !common.json) {
    throw new CliError("limits --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use limits --json --compact, or omit --compact.",
    });
  }

  return {
    ...common,
    ...(provider ? { provider } : {}),
    compact,
    timeoutMs,
  };
}

function parseProviderLimitProvider(value: string): BuiltInProviderLimitProvider {
  if (isBuiltInProviderLimitProvider(value)) {
    return value;
  }

  throw new CliError(`Unsupported limits provider "${value}".`, {
    reason: "invalid_option_value",
    input: value,
    matches: ["codex", "copilot", "claude"],
    hint: "Use --provider with one of: codex, copilot, claude.",
  });
}
