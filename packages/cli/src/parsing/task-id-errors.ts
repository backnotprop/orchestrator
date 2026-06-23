import { CliError } from "../cli-errors.ts";

export function missingTaskIdError(command: string): CliError {
  return new CliError(`${command} requires a task id.`, {
    reason: "missing_required_argument",
    input: "task-id",
    hint: "Pass one task id or unique prefix. Run orchestrator ps --json --compact --active for active tasks, or orchestrator ps --all --json --compact for history.",
  });
}

export function duplicateTaskIdError(command: string): CliError {
  return new CliError(`${command} accepts exactly one task id.`, {
    reason: "too_many_arguments",
    input: "task-id",
    hint: "Pass exactly one task id or unique prefix.",
  });
}
