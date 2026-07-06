import { CliError } from "../cli-errors.ts";

export function parseInternalRunTaskOptions(args: readonly string[]): string {
  return parseInternalRequestPathOptions("__run-task", args);
}

export function parseInternalMonitorSessionOperationOptions(args: readonly string[]): string {
  return parseInternalRequestPathOptions("__monitor-session-operation", args);
}

function parseInternalRequestPathOptions(command: string, args: readonly string[]): string {
  const [requestPath, ...extra] = args;
  if (!requestPath || extra.length > 0) {
    throw new CliError(`${command} requires exactly one request path.`);
  }
  return requestPath;
}
