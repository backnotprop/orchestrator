import { availableCatalog, unavailableCatalog } from "./catalogs.ts";
import { readCliVersion, runModelCommand, type ModelCommandRunner } from "./command.ts";
import type { RuntimeModel, RuntimeModelReader } from "./types.ts";

const SOURCE = "copilot help config";

export type CopilotModelReaderOptions = {
  readonly runCommand?: ModelCommandRunner;
};

/** Creates Copilot model discovery from the CLI's current configuration help. */
export function createCopilotModelReader(
  options: CopilotModelReaderOptions = {},
): RuntimeModelReader {
  const runCommand = options.runCommand ?? runModelCommand;
  return {
    runtimeIds: ["copilot"],
    async read(input) {
      const baseCommand = {
        executable: input.runtime.launch.executable,
        cwd: input.workspaceRoot,
        timeoutMs: input.timeoutMs,
        ...(input.runtime.launch.env ? { env: input.runtime.launch.env } : {}),
      };
      const [config, help, cliVersion] = await Promise.all([
        runCommand({ ...baseCommand, args: ["help", "config"] }),
        runCommand({ ...baseCommand, args: ["--help"] }),
        readCliVersion(
          {
            executable: input.runtime.detect.command,
            args: input.runtime.detect.versionArgs ?? ["--version"],
            cwd: input.workspaceRoot,
            timeoutMs: input.timeoutMs,
            ...(input.runtime.launch.env ? { env: input.runtime.launch.env } : {}),
          },
          runCommand,
        ),
      ]);
      if (!config.ok) {
        return unavailableCatalog(input, {
          source: SOURCE,
          ...(cliVersion ? { cliVersion } : {}),
          error: {
            ...config.error,
            hint: "Run `copilot help config` directly to inspect the installed model catalog.",
          },
        });
      }

      const parsed = parseCopilotModels(config.stdout, help.ok ? help.stdout : "");
      if (!parsed.ok) {
        return unavailableCatalog(input, {
          source: SOURCE,
          ...(cliVersion ? { cliVersion } : {}),
          error: { code: "invalid_model_catalog", message: parsed.message },
        });
      }

      return availableCatalog(input, {
        source: SOURCE,
        ...(cliVersion ? { cliVersion } : {}),
        models: parsed.models,
      });
    },
  };
}

function parseCopilotModels(
  configOutput: string,
  helpOutput: string,
):
  | { readonly ok: true; readonly models: readonly RuntimeModel[] }
  | { readonly ok: false; readonly message: string } {
  const lines = configOutput.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => /^\s*`model`\s*:/.test(line));
  if (sectionStart < 0) {
    return { ok: false, message: "Copilot did not print its model configuration section." };
  }

  const sectionEndOffset = lines
    .slice(sectionStart + 1)
    .findIndex((line) => /^\s*`[^`]+`\s*:/.test(line));
  const sectionEnd = sectionEndOffset < 0 ? lines.length : sectionStart + 1 + sectionEndOffset;
  const models: RuntimeModel[] = lines
    .slice(sectionStart + 1, sectionEnd)
    .flatMap((line): RuntimeModel[] => {
      const id = /^\s*-\s+"([^"]+)"\s*$/.exec(line)?.[1];
      return id ? [{ id, kind: "model" }] : [];
    });

  if (copilotSupportsAuto(helpOutput)) {
    models.unshift({ id: "auto", kind: "router", displayName: "Automatic" });
  }
  if (models.length === 0) {
    return { ok: false, message: "Copilot returned an empty model catalog." };
  }

  return { ok: true, models };
}

function copilotSupportsAuto(helpOutput: string): boolean {
  const normalized = helpOutput.replaceAll(/\s+/g, " ");
  return /--model <model>.*?use ['"]auto['"].*?pick automatically/i.test(normalized);
}
