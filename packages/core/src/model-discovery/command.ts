import { execFile } from "node:child_process";

export type ModelCommandInput = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type ModelCommandFailure = {
  readonly code: "executable_not_found" | "timeout" | "command_failed";
  readonly message: string;
};

export type ModelCommandResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly error: ModelCommandFailure };

export type ModelCommandRunner = (input: ModelCommandInput) => Promise<ModelCommandResult>;

export type ModelCommandWithVersionResult = {
  readonly command: ModelCommandResult;
  readonly cliVersion?: string;
};

/** Runs one provider CLI command without a shell and classifies expected process failures. */
export async function runModelCommand(input: ModelCommandInput): Promise<ModelCommandResult> {
  return await new Promise((resolve) => {
    execFile(
      input.executable,
      [...input.args],
      {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        encoding: "utf8",
        maxBuffer: 2_000_000,
        timeout: input.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout, stderr });
          return;
        }

        const code = nodeErrorCode(error);
        if (code === "ENOENT") {
          resolve({
            ok: false,
            error: {
              code: "executable_not_found",
              message: `Executable "${input.executable}" was not found.`,
            },
          });
          return;
        }

        if (error.killed) {
          resolve({
            ok: false,
            error: {
              code: "timeout",
              message: `Command "${input.executable}" timed out after ${input.timeoutMs}ms.`,
            },
          });
          return;
        }

        const exitCode = typeof error.code === "number" ? ` with exit code ${error.code}` : "";
        resolve({
          ok: false,
          error: {
            code: "command_failed",
            message: `Command "${input.executable}" failed${exitCode}.`,
          },
        });
      },
    );
  });
}

/** Reads a provider CLI version without making catalog discovery depend on it. */
export async function readCliVersion(
  input: ModelCommandInput,
  run: ModelCommandRunner = runModelCommand,
): Promise<string | undefined> {
  const result = await run({
    ...input,
    timeoutMs: Math.min(input.timeoutMs, 3_000),
  });
  if (!result.ok) {
    return undefined;
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

/** Runs catalog and version commands concurrently because neither depends on the other. */
export async function runModelCommandWithVersion(
  input: ModelCommandInput & {
    readonly versionExecutable: string;
    readonly versionArgs: readonly string[];
  },
  run: ModelCommandRunner = runModelCommand,
): Promise<ModelCommandWithVersionResult> {
  const commandInput: ModelCommandInput = {
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    ...(input.env ? { env: input.env } : {}),
  };
  const [command, cliVersion] = await Promise.all([
    run(commandInput),
    readCliVersion(
      {
        executable: input.versionExecutable,
        args: input.versionArgs,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        ...(input.env ? { env: input.env } : {}),
      },
      run,
    ),
  ]);
  return {
    command,
    ...(cliVersion ? { cliVersion } : {}),
  };
}

function nodeErrorCode(error: Error): string | undefined {
  if (!("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
