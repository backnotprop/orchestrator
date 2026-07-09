import { availableCatalog, unavailableCatalog } from "./catalogs.ts";
import { runModelCommand, runModelCommandWithVersion, type ModelCommandRunner } from "./command.ts";
import type { RuntimeModel, RuntimeModelReader } from "./types.ts";

const SOURCE = "pi --list-models";

export type PiModelReaderOptions = {
  readonly runCommand?: ModelCommandRunner;
};

/** Creates Pi model discovery from the current authenticated provider catalog. */
export function createPiModelReader(options: PiModelReaderOptions = {}): RuntimeModelReader {
  const runCommand = options.runCommand ?? runModelCommand;
  return {
    runtimeIds: ["pi"],
    async read(input) {
      const result = await runModelCommandWithVersion(
        {
          executable: input.runtime.launch.executable,
          args: ["--list-models"],
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
            hint: "Run `pi --list-models` directly to check provider authentication.",
          },
        });
      }

      const parsed = parsePiModels(result.command.stdout);
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
        models: parsed.models,
      });
    },
  };
}

function parsePiModels(
  stdout: string,
):
  | { readonly ok: true; readonly models: readonly RuntimeModel[] }
  | { readonly ok: false; readonly message: string } {
  const lines = stdout.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    /^provider\s+model\s+context\s+/i.test(line.trim()),
  );
  if (headerIndex < 0) {
    return { ok: false, message: "Pi did not print the expected model table header." };
  }

  const models = lines.slice(headerIndex + 1).flatMap((line): RuntimeModel[] => {
    const columns = line.trim().split(/\s+/);
    const provider = columns[0];
    const model = columns[1];
    if (!provider || !model) {
      return [];
    }
    const supportsImages = columns[5] === "yes";
    return [
      {
        id: `${provider}/${model}`,
        kind: "model",
        displayName: model,
        provider,
        inputModalities: supportsImages ? ["text", "image"] : ["text"],
      },
    ];
  });
  if (models.length === 0) {
    return { ok: false, message: "Pi returned an empty model catalog." };
  }

  return { ok: true, models };
}
