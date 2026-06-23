import { CliError } from "../cli-errors.ts";

export function requireJsonForCompact(command: string, compact: boolean, json: boolean): void {
  if (!compact || json) {
    return;
  }

  throw new CliError(`${command} --compact requires --json.`, {
    reason: "missing_required_option",
    input: "--compact",
    hint: "Add --json or omit --compact.",
  });
}
