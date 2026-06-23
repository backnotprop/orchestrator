import { CliError } from "../cli-errors.ts";

export function parseInternalRunTaskOptions(args: readonly string[]): string {
  const [requestPath, ...extra] = args;
  if (!requestPath || extra.length > 0) {
    throw new CliError("__run-task requires exactly one request path.");
  }
  return requestPath;
}
