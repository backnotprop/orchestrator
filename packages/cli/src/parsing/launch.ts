import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { LaunchOptions } from "../commands/launch.ts";
import { parseCommonOption } from "./common-options.ts";
import {
  defaultCommonOptions,
  parseIntegerOption,
  parseTaskName,
  requireValue,
} from "./primitives.ts";
import { requireJsonForCompact } from "./validation.ts";

export function parseLaunchOptions(args: readonly string[]): LaunchOptions {
  const common = defaultCommonOptions();
  let runtime: string | undefined;
  const taskParts: string[] = [];
  let file: string | undefined;
  let cwd: string | undefined;
  let name: string | undefined;
  let model: string | undefined;
  let outputMode: string | undefined;
  let timeoutMs: number | undefined;
  let maxOutputBytes: number | undefined;
  let wait = false;
  let session = false;
  let compact = false;
  let brief = false;
  let allowDisabledRuntime = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      taskParts.push(...args.slice(index + 1));
      break;
    }

    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    if (!runtime && arg && !arg.startsWith("-")) {
      runtime = arg;
      continue;
    }

    switch (arg) {
      case "--file":
      case "-f":
        file = requireValue(args, ++index, arg);
        break;
      case "--cwd":
        cwd = requireValue(args, ++index, arg);
        break;
      case "--name":
        name = parseTaskName(requireValue(args, ++index, arg));
        break;
      case "--model":
        model = requireValue(args, ++index, arg);
        break;
      case "--output-mode":
        outputMode = requireValue(args, ++index, arg);
        break;
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--max-output-bytes":
        maxOutputBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--wait":
        wait = true;
        break;
      case "--session":
        session = true;
        break;
      case "--compact":
        compact = true;
        break;
      case "--brief":
        brief = true;
        break;
      case "--allow-disabled-runtime":
        allowDisabledRuntime = true;
        break;
      default:
        if (!arg) {
          break;
        }
        if (arg.startsWith("-")) {
          throw unknownOptionError("launch", arg);
        }
        taskParts.push(arg);
    }
  }

  if (file && (runtime || taskParts.length > 0)) {
    throw new CliError("launch -f cannot be combined with a positional runtime or task.", {
      reason: "incompatible_options",
      input: "--file",
      hint: "Use launch -f <manifest.json> --json, or use launch <runtime> <task>.",
    });
  }
  if (file && wait) {
    throw new CliError("launch -f does not support --wait yet.", {
      reason: "incompatible_options",
      input: "--wait",
      hint: "Use the returned commands.waitPreview.args to wait for the launched tasks.",
    });
  }
  if (session && wait) {
    throw new CliError("launch --session does not support --wait.", {
      reason: "incompatible_options",
      input: "--wait",
      hint: "Start the session in the background, then use ps, events, or interrupt.",
    });
  }
  if (file && session) {
    throw new CliError("launch -f does not support --session yet.", {
      reason: "incompatible_options",
      input: "--session",
      hint: "Start persistent sessions one at a time with launch <runtime> --session.",
    });
  }
  if (file && name) {
    throw new CliError("launch -f does not support --name.", {
      reason: "incompatible_options",
      input: "--name",
      hint: "Set name on each task in the launch manifest.",
    });
  }
  if (file && !common.json) {
    throw new CliError("launch -f requires --json.", {
      reason: "missing_required_option",
      input: "--json",
      hint: "Use launch -f <manifest.json> --json --compact --brief.",
    });
  }

  if (!file && !runtime) {
    throw new CliError("launch requires a runtime.");
  }

  const task = taskParts.join(" ").trim();
  if (!file && !task && !session) {
    throw new CliError("launch requires task instructions.");
  }
  if (!file && task && session) {
    throw new CliError("launch --session does not accept task instructions yet.", {
      reason: "incompatible_options",
      input: "--session",
      hint: "Start the session first, then send work with orchestrator send.",
    });
  }
  requireJsonForCompact("launch", compact, common.json);
  if (brief && !compact) {
    throw new CliError("launch --brief requires --compact.", {
      reason: "missing_required_option",
      input: "--brief",
      hint: "Use launch --json --compact --brief, or omit --brief.",
    });
  }

  return {
    ...common,
    ...(runtime ? { runtime } : {}),
    ...(task ? { task } : {}),
    ...(file ? { file } : {}),
    ...(cwd ? { cwd } : {}),
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(outputMode ? { outputMode } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
    wait,
    session,
    compact,
    brief,
    allowDisabledRuntime,
  };
}
