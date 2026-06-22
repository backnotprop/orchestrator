export class CliError extends Error {
  readonly reason?: string;
  readonly input?: string;
  readonly matches?: readonly string[];
  readonly hint?: string;

  constructor(
    message: string,
    details: {
      reason?: string;
      input?: string;
      matches?: readonly string[];
      hint?: string;
    } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.reason = details.reason;
    this.input = details.input;
    this.matches = details.matches;
    this.hint = details.hint;
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function wantsJsonError(argv: readonly string[]): boolean {
  return argv.includes("--json") || argv.includes("--compact") || argv.includes("--brief");
}

export function unknownCommandError(
  command: string,
  options: { json: boolean; helpText: () => string },
): CliError {
  return new CliError(
    options.json
      ? `Unknown command "${command}".`
      : `Unknown command "${command}".\n\n${options.helpText()}`,
    {
      reason: "unknown_command",
      input: command,
      hint: "Run orchestrator help --json --compact and choose one of commands[].name.",
    },
  );
}

export function unknownOptionError(command: string, option: string): CliError {
  return new CliError(`Unknown ${command} option "${option}".`, {
    reason: "unknown_option",
    input: option,
    hint: `Run orchestrator help --json --compact for command usage, or help --json for full options for command "${command}".`,
  });
}

export function cliErrorJson(error: unknown): {
  schemaVersion: 1;
  error: {
    name: string;
    message: string;
    reason?: string;
    input?: string;
    matches?: string[];
    hint?: string;
  };
} {
  return {
    schemaVersion: 1,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: formatError(error),
      ...optionalErrorString(error, "reason"),
      ...optionalErrorString(error, "input"),
      ...optionalErrorStringArray(error, "matches"),
      ...optionalErrorString(error, "hint"),
    },
  };
}

function optionalErrorString(error: unknown, key: string): Record<string, string> {
  if (!error || typeof error !== "object") {
    return {};
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function optionalErrorStringArray(error: unknown, key: string): Record<string, string[]> {
  if (!error || typeof error !== "object") {
    return {};
  }
  const value = (error as Record<string, unknown>)[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? { [key]: value }
    : {};
}
