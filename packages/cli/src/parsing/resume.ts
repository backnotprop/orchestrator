import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { ResumeOptions } from "../commands/resume.ts";
import { parseCommonOption } from "./common-options.ts";
import {
  defaultCommonOptions,
  parseIntegerOption,
  parseTaskName,
  requireValue,
} from "./primitives.ts";
import { requireJsonForCompact } from "./validation.ts";

export function parseResumeOptions(args: readonly string[]): ResumeOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  const taskParts: string[] = [];
  let name: string | undefined;
  let model: string | undefined;
  let outputMode: string | undefined;
  let timeoutMs: number | undefined;
  let maxOutputBytes: number | undefined;
  let wait = false;
  let compact = false;
  let brief = false;

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

    if (!taskId && arg && !arg.startsWith("-")) {
      taskId = arg;
      continue;
    }

    switch (arg) {
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
      case "--compact":
        compact = true;
        break;
      case "--brief":
        brief = true;
        break;
      default:
        if (!arg) {
          break;
        }
        if (arg.startsWith("-")) {
          throw unknownOptionError("resume", arg);
        }
        taskParts.push(arg);
    }
  }

  if (!taskId) {
    throw new CliError("resume requires a task id.");
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    throw new CliError("resume requires next task instructions.");
  }
  requireJsonForCompact("resume", compact, common.json);
  if (brief && !compact) {
    throw new CliError("resume --brief requires --compact.", {
      reason: "missing_required_option",
      input: "--brief",
      hint: "Use resume --json --compact --brief, or omit --brief.",
    });
  }

  return {
    ...common,
    taskId,
    task,
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(outputMode ? { outputMode } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
    wait,
    compact,
    brief,
  };
}
