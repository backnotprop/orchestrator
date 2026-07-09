import { availableCatalog, unavailableCatalog } from "./catalogs.ts";
import { runModelCommand, runModelCommandWithVersion, type ModelCommandRunner } from "./command.ts";
import type { RuntimeModel, RuntimeModelReader } from "./types.ts";

const SOURCE = "grok models";

export type GrokModelReaderOptions = {
  readonly runCommand?: ModelCommandRunner;
};

/** Creates Grok model discovery from the authenticated CLI catalog. */
export function createGrokModelReader(options: GrokModelReaderOptions = {}): RuntimeModelReader {
  const runCommand = options.runCommand ?? runModelCommand;
  return {
    runtimeIds: ["grok"],
    async read(input) {
      const result = await runModelCommandWithVersion(
        {
          executable: input.runtime.launch.executable,
          args: ["models"],
          versionExecutable: input.runtime.detect.command,
          versionArgs: input.runtime.detect.versionArgs ?? ["version"],
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
            hint: "Run `grok models` directly to check authentication and model availability.",
          },
        });
      }

      const parsed = parseGrokModels(result.command.stdout);
      if (!parsed.ok) {
        return unavailableCatalog(input, {
          source: SOURCE,
          ...(result.cliVersion ? { cliVersion: result.cliVersion } : {}),
          error: { code: "invalid_model_catalog", message: parsed.message },
        });
      }

      return availableCatalog(input, {
        source: SOURCE,
        ...(result.cliVersion ? { cliVersion: result.cliVersion } : {}),
        ...(parsed.defaultModel ? { defaultModel: parsed.defaultModel } : {}),
        models: parsed.models,
      });
    },
  };
}

function parseGrokModels(
  stdout: string,
):
  | { readonly ok: true; readonly models: readonly RuntimeModel[]; readonly defaultModel?: string }
  | { readonly ok: false; readonly message: string } {
  const availableIndex = stdout.indexOf("Available models:");
  if (availableIndex < 0) {
    return { ok: false, message: "Grok did not print an Available models section." };
  }

  const defaultModel = /^Default model:\s*(\S+)\s*$/m.exec(stdout)?.[1];
  const models = stdout
    .slice(availableIndex + "Available models:".length)
    .split(/\r?\n/)
    .flatMap((line): RuntimeModel[] => {
      const match = /^\s*(?:\*|-)\s+([^\s(]+)(?:\s+\(default\))?\s*$/.exec(line);
      if (!match?.[1]) {
        return [];
      }
      return [
        {
          id: match[1],
          kind: "model",
          ...(match[1] === defaultModel || line.includes("(default)") ? { isDefault: true } : {}),
        },
      ];
    });
  if (models.length === 0) {
    return { ok: false, message: "Grok returned an empty or unrecognized model catalog." };
  }

  return {
    ok: true,
    models,
    ...(defaultModel ? { defaultModel } : {}),
  };
}
