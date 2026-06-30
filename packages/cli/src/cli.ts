#!/usr/bin/env -S node --experimental-strip-types
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandRunTask } from "./background-task.ts";
import { formatError, unknownCommandError, wantsJsonError } from "./cli-errors.ts";
import { cliErrorJsonWithRecovery } from "./cli-error-recovery.ts";
import { commandDoctor } from "./commands/doctor.ts";
import { buildCliHelpText, commandHelp } from "./commands/help.ts";
import { commandInterrupt } from "./commands/interrupt.ts";
import { commandLaunch } from "./commands/launch.ts";
import { commandList } from "./commands/list.ts";
import { commandPs } from "./commands/ps.ts";
import { commandResume } from "./commands/resume.ts";
import { commandRun, commandRunParentTask } from "./commands/run.ts";
import { commandEvents, commandLogs, commandRead } from "./commands/task-inspection.ts";
import { commandWatch } from "./commands/watch.ts";
import { parseDoctorOptions } from "./parsing/doctor.ts";
import { parseHelpOptions } from "./parsing/help.ts";
import { parseInternalRunTaskOptions } from "./parsing/internal.ts";
import { parseInterruptOptions } from "./parsing/interrupt.ts";
import { parseLaunchOptions } from "./parsing/launch.ts";
import { parseListOptions } from "./parsing/list.ts";
import { normalizeLeadingCommonOptions } from "./parsing/leading-common-options.ts";
import { parsePsOptions } from "./parsing/ps.ts";
import { parseResumeOptions } from "./parsing/resume.ts";
import { parseRunOptions } from "./parsing/run.ts";
import {
  parseEventsOptions,
  parseLogsOptions,
  parseReadOptions,
} from "./parsing/task-inspection.ts";
import { parseWatchOptions } from "./parsing/watch.ts";

const CLI_ENTRY_PATH = fileURLToPath(import.meta.url);

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const normalizedArgv = normalizeLeadingCommonOptions(argv);
    const [command, ...rest] = normalizedArgv;

    switch (command) {
      case "launch":
        await commandLaunch(parseLaunchOptions(rest), { cliEntryPath: CLI_ENTRY_PATH });
        return 0;
      case "resume":
        await commandResume(parseResumeOptions(rest), { cliEntryPath: CLI_ENTRY_PATH });
        return 0;
      case "list":
        await commandList(parseListOptions(rest));
        return 0;
      case "ps":
        await commandPs(parsePsOptions(rest));
        return 0;
      case "read":
        await commandRead(parseReadOptions(rest));
        return 0;
      case "logs":
        await commandLogs(parseLogsOptions(rest));
        return 0;
      case "events":
        await commandEvents(parseEventsOptions(rest));
        return 0;
      case "watch":
        await commandWatch(parseWatchOptions(rest));
        return 0;
      case "interrupt":
        return await commandInterrupt(parseInterruptOptions(rest));
      case "run":
        await commandRun(parseRunOptions(rest), { cliEntryPath: CLI_ENTRY_PATH });
        return 0;
      case "doctor":
        return await commandDoctor(parseDoctorOptions(rest));
      case "__run-task":
        await commandRunTask(parseInternalRunTaskOptions(rest));
        return 0;
      case "__run-parent-task":
        await commandRunParentTask(parseInternalRunTaskOptions(rest), {
          cliEntryPath: CLI_ENTRY_PATH,
        });
        return 0;
      case undefined:
      case "-h":
      case "--help":
      case "help":
        await commandHelp(parseHelpOptions(rest));
        return command ? 0 : 1;
      default:
        throw unknownCommandError(String(command), {
          json: wantsJsonError(argv),
          helpText: buildCliHelpText,
        });
    }
  } catch (error) {
    if (wantsJsonError(argv)) {
      process.stderr.write(`${JSON.stringify(cliErrorJsonWithRecovery(error, argv))}\n`);
    } else {
      process.stderr.write(`${formatError(error)}\n`);
    }
    return 1;
  }
}

if (isDirectEntrypoint()) {
  process.exitCode = await main();
}

function isDirectEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
}
