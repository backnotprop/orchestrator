import { resolve } from "node:path";
import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { ParentToolTraceMode, RunOptions } from "../commands/run.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseTaskName, requireValue } from "./primitives.ts";

export function parseRunOptions(args: readonly string[]): RunOptions {
  const common = defaultCommonOptions();
  const requestParts: string[] = [];
  let agentDir: string | undefined;
  let sessionDir: string | undefined;
  let name: string | undefined;
  let background = false;
  let compact = false;
  let brief = false;
  let traceTools: ParentToolTraceMode = "off";
  let streamJson = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      requestParts.push(...args.slice(index + 1));
      break;
    }

    const commonOption = parseCommonOption(args, index, common);
    if (commonOption.matched) {
      index = commonOption.nextIndex;
      continue;
    }

    switch (arg) {
      case "--agent-dir":
        agentDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--session-dir":
        sessionDir = resolve(requireValue(args, ++index, arg));
        break;
      case "--name":
        name = parseTaskName(requireValue(args, ++index, arg));
        break;
      case "--background":
        background = true;
        break;
      case "--compact":
        compact = true;
        break;
      case "--brief":
        brief = true;
        break;
      case "--trace-tools":
        traceTools = "text";
        break;
      case "--stream-json":
        streamJson = true;
        break;
      default:
        if (!arg) {
          break;
        }
        if (arg.startsWith("--trace-tools=")) {
          traceTools = parseParentToolTraceMode(arg.slice("--trace-tools=".length), arg);
          break;
        }
        if (arg.startsWith("-")) {
          throw unknownOptionError("run", arg);
        }
        requestParts.push(arg);
    }
  }

  const request = requestParts.join(" ").trim();
  if (!request) {
    throw new CliError("run requires a user request.");
  }

  if (streamJson && common.json) {
    throw new CliError("run --stream-json cannot be combined with --json.", {
      reason: "incompatible_options",
      input: "--stream-json",
      hint: "Use --stream-json for JSONL event streams, or --json for one JSON result.",
    });
  }
  if (compact && !common.json) {
    throw new CliError("run --compact requires --json.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use run --background --json --compact, or omit --compact.",
    });
  }
  if (brief && !compact) {
    throw new CliError("run --brief requires --compact.", {
      reason: "missing_required_option",
      input: "--brief",
      hint: "Use run --background --json --compact --brief, or omit --brief.",
    });
  }
  if (compact && !background) {
    throw new CliError("run --compact requires --background.", {
      reason: "missing_required_option",
      input: "--compact",
      hint: "Use run --background --json --compact, or omit --compact.",
    });
  }
  if (background && traceTools !== "off") {
    throw new CliError("run --background cannot be combined with --trace-tools.", {
      reason: "incompatible_options",
      input: "--trace-tools",
      hint: "Use foreground run with --trace-tools, or background run with ps/read/watch.",
    });
  }
  if (background && streamJson) {
    throw new CliError("run --background cannot be combined with --stream-json.", {
      reason: "incompatible_options",
      input: "--stream-json",
      hint: "Use foreground run with --stream-json, or background run with ps/read/watch.",
    });
  }
  if (name && !background) {
    throw new CliError("run --name requires --background.", {
      reason: "missing_required_option",
      input: "--name",
      hint: "Use run --background --name <name>, or omit --name.",
    });
  }

  return {
    ...common,
    request,
    ...(name ? { name } : {}),
    background,
    compact,
    brief,
    traceTools,
    streamJson,
    ...(agentDir ? { agentDir } : {}),
    ...(sessionDir ? { sessionDir } : {}),
  };
}

function parseParentToolTraceMode(value: string, option: string): ParentToolTraceMode {
  if (value === "text" || value === "jsonl") {
    return value;
  }
  throw new CliError(`${option} must be text or jsonl.`, {
    reason: "invalid_option_value",
    input: value,
    hint: "Use --trace-tools=text or --trace-tools=jsonl.",
  });
}
