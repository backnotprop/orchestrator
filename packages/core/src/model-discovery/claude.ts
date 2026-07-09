import { availableCatalog, unavailableCatalog } from "./catalogs.ts";
import { runModelCommand, runModelCommandWithVersion, type ModelCommandRunner } from "./command.ts";
import type { RuntimeModel, RuntimeModelReader } from "./types.ts";

const SOURCE = "claude --help";

export type ClaudeModelReaderOptions = {
  readonly runCommand?: ModelCommandRunner;
};

/** Creates Claude Code model discovery from its live latest-family aliases. */
export function createClaudeModelReader(
  options: ClaudeModelReaderOptions = {},
): RuntimeModelReader {
  const runCommand = options.runCommand ?? runModelCommand;
  return {
    runtimeIds: ["claude-code"],
    async read(input) {
      const result = await runModelCommandWithVersion(
        {
          executable: input.runtime.launch.executable,
          args: ["--help"],
          versionExecutable: input.runtime.detect.command,
          versionArgs: input.runtime.detect.versionArgs ?? ["--version"],
          cwd: input.workspaceRoot,
          timeoutMs: input.timeoutMs,
          ...(input.runtime.launch.env ? { env: input.runtime.launch.env } : {}),
        },
        runCommand,
      );
      if (!result.command.ok) {
        return unavailableCatalog(input, {
          source: SOURCE,
          ...(result.cliVersion ? { cliVersion: result.cliVersion } : {}),
          error: {
            ...result.command.error,
            hint: "Omit --model to use Claude Code's default model.",
          },
        });
      }

      const aliases = parseClaudeAliases(result.command.stdout);
      return availableCatalog(input, {
        status: "partial",
        source: SOURCE,
        ...(result.cliVersion ? { cliVersion: result.cliVersion } : {}),
        models: aliases,
        ...(aliases.length === 0
          ? {
              error: {
                code: "exact_catalog_unavailable",
                message: "Claude Code does not expose a machine-readable model catalog.",
                hint: "Omit --model to use the default, or inspect `claude --help` for aliases.",
              },
            }
          : {}),
      });
    },
  };
}

function parseClaudeAliases(stdout: string): readonly RuntimeModel[] {
  const normalized = stdout.replaceAll(/\s+/g, " ");
  const examples = /alias for the latest model\s*\(e\.g\.\s*([^)]+)\)/i.exec(normalized)?.[1];
  if (!examples) {
    return [];
  }

  return [...examples.matchAll(/['"]([a-z0-9][a-z0-9._-]*)['"]/gi)].flatMap(
    (match): RuntimeModel[] => {
      const id = match[1];
      return id ? [{ id, kind: "alias" }] : [];
    },
  );
}
