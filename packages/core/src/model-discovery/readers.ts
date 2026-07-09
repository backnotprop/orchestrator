import { unavailableCatalog, unsupportedCatalog } from "./catalogs.ts";
import { createClaudeModelReader } from "./claude.ts";
import { createCodexModelReader } from "./codex.ts";
import { createCopilotModelReader } from "./copilot.ts";
import { createGrokModelReader } from "./grok.ts";
import { createPiModelReader } from "./pi.ts";
import type {
  RuntimeModelCatalog,
  RuntimeModelReader,
  RuntimeModelReaderInput,
  RuntimeModelsReport,
} from "./types.ts";
import type { HeadlessAgentRuntimeConfig } from "../runtime/types.ts";

export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

export type ReadRuntimeModelsInput = {
  readonly runtimes: readonly HeadlessAgentRuntimeConfig[];
  readonly workspaceRoot: string;
  readonly orchestratorDir?: string;
  readonly timeoutMs?: number;
  readonly now?: Date;
  readonly readers?: readonly RuntimeModelReader[];
};

/** Returns the built-in runtime model adapters in provider-neutral form. */
export function defaultRuntimeModelReaders(): readonly RuntimeModelReader[] {
  return [
    createCodexModelReader(),
    createClaudeModelReader(),
    createCopilotModelReader(),
    createGrokModelReader(),
    createPiModelReader(),
  ];
}

/** Discovers launchable model values for each requested runtime without failing peer catalogs. */
export async function readRuntimeModels(
  input: ReadRuntimeModelsInput,
): Promise<RuntimeModelsReport> {
  const now = input.now ?? new Date();
  const timeoutMs = input.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
  const readers = input.readers ?? defaultRuntimeModelReaders();
  const catalogs = await Promise.all(
    input.runtimes.map(async (runtime) => {
      const readerInput: RuntimeModelReaderInput = {
        runtime,
        workspaceRoot: input.workspaceRoot,
        ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
        timeoutMs,
        now,
      };
      const reader = readers.find((candidate) => candidate.runtimeIds.includes(runtime.id));
      if (!reader) {
        return unsupportedCatalog(readerInput);
      }
      return await readRuntimeCatalog(reader, readerInput);
    }),
  );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    runtimes: catalogs,
  };
}

async function readRuntimeCatalog(
  reader: RuntimeModelReader,
  input: RuntimeModelReaderInput,
): Promise<RuntimeModelCatalog> {
  try {
    return await reader.read(input);
  } catch (error: unknown) {
    return unavailableCatalog(input, {
      source: "reader",
      error: {
        code: "model_discovery_failed",
        message: error instanceof Error ? error.message : "Runtime model discovery failed.",
      },
    });
  }
}
