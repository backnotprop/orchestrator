import { resolve } from "node:path";
import type { TaskStatus } from "@backnotprop/orchestrator-core";
import { CliError, unknownOptionError } from "../cli-errors.ts";
import type { PsOptions } from "../commands/ps.ts";
import { parseCommonOption } from "./common-options.ts";
import {
  defaultCommonOptions,
  parseIntegerOption,
  parseTaskStatus,
  requireValue,
} from "./primitives.ts";
import { requireJsonForCompact } from "./validation.ts";

export function parsePsOptions(args: readonly string[]): PsOptions {
  const common = defaultCommonOptions();
  let status: TaskStatus | undefined;
  let runtime: string | undefined;
  let parentRunId: string | undefined;
  let all = false;
  let allWorkspaces = false;
  let cwd: string | undefined;
  let watch = false;
  let compact = false;
  let brief = false;
  let active = false;
  let intervalMs = 1_000;

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
      case "--runtime":
        runtime = requireValue(args, ++index, arg);
        break;
      case "--parent":
        parentRunId = requireValue(args, ++index, arg);
        break;
      case "--all":
        all = true;
        break;
      case "-A":
      case "--all-workspaces":
        allWorkspaces = true;
        break;
      case "--cwd":
        cwd = requireValue(args, ++index, arg);
        break;
      case "--watch":
      case "-w":
        watch = true;
        break;
      case "--compact":
        compact = true;
        break;
      case "--brief":
        brief = true;
        break;
      case "--active":
        active = true;
        break;
      case "--interval-ms":
        intervalMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        throw unknownOptionError("ps", String(arg));
    }
  }

  requireJsonForCompact("ps", compact, common.json);
  if (active && !compact) {
    throw new CliError("ps --active requires --compact.", {
      reason: "missing_required_option",
      input: "--active",
      hint: "Use ps --json --compact --active.",
    });
  }
  if (brief && !compact) {
    throw new CliError("ps --brief requires --compact.", {
      reason: "missing_required_option",
      input: "--brief",
      hint: "Use ps --json --compact --active --brief.",
    });
  }

  return {
    ...common,
    ...(status ? { status } : {}),
    ...(runtime ? { runtime } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    all,
    allWorkspaces,
    ...(cwd ? { cwd: resolve(common.workspaceRoot, cwd) } : {}),
    watch,
    compact,
    brief,
    active,
    intervalMs,
  };
}
