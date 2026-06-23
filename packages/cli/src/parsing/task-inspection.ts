import { CliError, unknownOptionError } from "../cli-errors.ts";
import type {
  EventsOptions,
  LogsOptions,
  LogStream,
  ReadOptions,
} from "../commands/task-inspection.ts";
import { parseCommonOption } from "./common-options.ts";
import { defaultCommonOptions, parseIntegerOption, requireValue } from "./primitives.ts";
import { duplicateTaskIdError, missingTaskIdError } from "./task-id-errors.ts";
import { requireJsonForCompact } from "./validation.ts";

export function parseReadOptions(args: readonly string[]): ReadOptions {
  const common = defaultCommonOptions();
  const taskIds: string[] = [];
  let maxBytes: number | undefined;
  let wait = false;
  let compact = false;
  let timeoutMs: number | undefined;
  let intervalMs: number | undefined;

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
      case "--max-bytes":
        maxBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--wait":
        wait = true;
        break;
      case "--timeout-ms":
        timeoutMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--interval-ms":
        intervalMs = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("read", arg);
        }
        taskIds.push(arg);
    }
  }

  if (taskIds.length === 0) {
    throw missingTaskIdError("read");
  }
  requireJsonForCompact("read", compact, common.json);
  if (taskIds.length > 1 && !common.json) {
    throw new CliError("read multiple task ids requires --json.", {
      reason: "missing_required_option",
      input: "task-id",
      hint: "Use read <id> <id> --json --compact, or read one task at a time.",
    });
  }
  if (!wait && timeoutMs !== undefined) {
    throw new CliError("read --timeout-ms requires --wait.", {
      reason: "missing_required_option",
      input: "--timeout-ms",
      hint: "Add --wait or omit --timeout-ms.",
    });
  }
  if (!wait && intervalMs !== undefined) {
    throw new CliError("read --interval-ms requires --wait.", {
      reason: "missing_required_option",
      input: "--interval-ms",
      hint: "Add --wait or omit --interval-ms.",
    });
  }

  return {
    ...common,
    taskIds,
    ...(maxBytes ? { maxBytes } : {}),
    wait,
    compact,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  };
}

export function parseLogsOptions(args: readonly string[]): LogsOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let maxBytes: number | undefined;
  let stream: LogStream = "all";
  let follow = false;
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
      case "--max-bytes":
        maxBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--stream":
        stream = parseLogStream(requireValue(args, ++index, arg));
        break;
      case "--follow":
      case "-f":
        follow = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("logs", arg);
        }
        if (taskId) {
          throw duplicateTaskIdError("logs");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw missingTaskIdError("logs");
  }

  requireJsonForCompact("logs", compact, common.json);

  return {
    ...common,
    taskId,
    stream,
    follow,
    compact,
    ...(maxBytes ? { maxBytes } : {}),
  };
}

export function parseEventsOptions(args: readonly string[]): EventsOptions {
  const common = defaultCommonOptions();
  let taskId: string | undefined;
  let maxBytes: number | undefined;
  let agentOnly = false;
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
      case "--max-bytes":
        maxBytes = parseIntegerOption(requireValue(args, ++index, arg), arg);
        break;
      case "--agent-only":
        agentOnly = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw unknownOptionError("events", arg);
        }
        if (taskId) {
          throw duplicateTaskIdError("events");
        }
        taskId = arg;
    }
  }

  if (!taskId) {
    throw missingTaskIdError("events");
  }

  requireJsonForCompact("events", compact, common.json);

  return {
    ...common,
    taskId,
    agentOnly,
    compact,
    ...(maxBytes ? { maxBytes } : {}),
  };
}

function parseLogStream(value: string): LogStream {
  if (value === "stdout" || value === "stderr" || value === "all") {
    return value;
  }
  throw new CliError("--stream must be one of: stdout, stderr, all.", {
    reason: "invalid_option_value",
    input: value,
    hint: "Use --stream stdout, --stream stderr, or --stream all.",
  });
}
