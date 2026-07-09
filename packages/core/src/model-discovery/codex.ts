import {
  CodexAppServerControllerError,
  withCodexAppServerConnection,
} from "../tasks/executors/protocol/codex-app-server-controller.ts";
import { JsonRpcWebSocketUnixClientError } from "../tasks/executors/protocol/json-rpc-websocket-unix.ts";
import { availableCatalog, unavailableCatalog } from "./catalogs.ts";
import { readCliVersion, runModelCommand, type ModelCommandRunner } from "./command.ts";
import type { RuntimeModel, RuntimeModelReader } from "./types.ts";

const SOURCE = "codex-app-server:model/list";
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

type CodexModelPage = {
  readonly models: readonly RuntimeModel[];
  readonly nextCursor?: string;
};

type CodexModelConnection = {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
};

export type CodexModelListParams = {
  readonly includeHidden: false;
  readonly limit: number;
  readonly cursor?: string;
};

export type CodexModelReaderOptions = {
  readonly runCommand?: ModelCommandRunner;
  readonly readPage?: (params: CodexModelListParams) => Promise<unknown>;
};

/** Creates live Codex model discovery backed by the app-server model/list protocol. */
export function createCodexModelReader(options: CodexModelReaderOptions = {}): RuntimeModelReader {
  const runCommand = options.runCommand ?? runModelCommand;
  const readPage = options.readPage;
  return {
    runtimeIds: ["codex", "codex-app-server"],
    async read(input) {
      const executable = input.runtime.launch.executable;
      const versionPromise = readCliVersion(
        {
          executable: input.runtime.detect.command,
          args: input.runtime.detect.versionArgs ?? ["--version"],
          cwd: input.workspaceRoot,
          timeoutMs: input.timeoutMs,
          ...(input.runtime.launch.env ? { env: input.runtime.launch.env } : {}),
        },
        runCommand,
      );

      try {
        const models = readPage
          ? await readCodexModelPages(
              {
                request: async (_method, params) => await readPage(parseModelListParams(params)),
              },
              input.timeoutMs,
            )
          : await readCodexModels({
              executable,
              cwd: input.workspaceRoot,
              ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
              timeoutMs: input.timeoutMs,
              ...(input.runtime.launch.env ? { env: input.runtime.launch.env } : {}),
            });
        const cliVersion = await versionPromise;
        return availableCatalog(input, {
          source: SOURCE,
          ...(cliVersion ? { cliVersion } : {}),
          ...defaultModel(models),
          models,
        });
      } catch (error: unknown) {
        const cliVersion = await versionPromise;
        return unavailableCatalog(input, {
          source: SOURCE,
          ...(cliVersion ? { cliVersion } : {}),
          error: classifyCodexError(error),
        });
      }
    },
  };
}

function parseModelListParams(value: unknown): CodexModelListParams {
  if (!isRecord(value)) {
    throw new CodexModelResponseError("Codex model/list request params were invalid.");
  }
  return {
    includeHidden: false,
    limit: typeof value.limit === "number" ? value.limit : PAGE_LIMIT,
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
  };
}

async function readCodexModels(input: {
  executable: string;
  cwd: string;
  orchestratorDir?: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<readonly RuntimeModel[]> {
  const requestTimeoutMs = Math.max(500, Math.floor(input.timeoutMs / 2));
  return await withCodexAppServerConnection(
    {
      executable: input.executable,
      cwd: input.cwd,
      ...(input.orchestratorDir ? { orchestratorDir: input.orchestratorDir } : {}),
      timeoutMs: input.timeoutMs,
      requestTimeoutMs,
      ...(input.env ? { env: input.env } : {}),
    },
    async (connection) => await readCodexModelPages(connection, requestTimeoutMs),
  );
}

async function readCodexModelPages(
  connection: CodexModelConnection,
  timeoutMs: number,
): Promise<readonly RuntimeModel[]> {
  const models = new Map<string, RuntimeModel>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const response: unknown = await connection.request(
      "model/list",
      {
        includeHidden: false,
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      },
      { timeoutMs },
    );
    const page = parseCodexModelPage(response);
    if (!page.ok) {
      throw new CodexModelResponseError(page.message);
    }

    for (const model of page.value.models) {
      models.set(model.id, model);
    }
    if (!page.value.nextCursor) {
      return [...models.values()];
    }
    if (seenCursors.has(page.value.nextCursor)) {
      throw new CodexModelResponseError("Codex model/list returned a repeated pagination cursor.");
    }
    seenCursors.add(page.value.nextCursor);
    cursor = page.value.nextCursor;
  }

  throw new CodexModelResponseError(`Codex model/list exceeded ${MAX_PAGES} pages.`);
}

function parseCodexModelPage(
  value: unknown,
):
  | { readonly ok: true; readonly value: CodexModelPage }
  | { readonly ok: false; readonly message: string } {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return { ok: false, message: "Codex model/list did not return a data array." };
  }

  const models: RuntimeModel[] = [];
  for (const item of value.data) {
    const model = parseCodexModel(item);
    if (!model.ok) {
      return model;
    }
    if (model.value) {
      models.push(model.value);
    }
  }

  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    return { ok: false, message: "Codex model/list returned an invalid nextCursor." };
  }

  return {
    ok: true,
    value: {
      models,
      ...(typeof nextCursor === "string" && nextCursor ? { nextCursor } : {}),
    },
  };
}

function parseCodexModel(
  value: unknown,
):
  | { readonly ok: true; readonly value: RuntimeModel | undefined }
  | { readonly ok: false; readonly message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Codex model/list returned a non-object model." };
  }
  if (value.hidden === true) {
    return { ok: true, value: undefined };
  }
  if (typeof value.model !== "string" || !value.model) {
    return { ok: false, message: "Codex model/list returned a model without a launchable id." };
  }

  return {
    ok: true,
    value: {
      id: value.model,
      kind: "model",
      ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(value.isDefault === true ? { isDefault: true } : {}),
      ...stringArrayProperty(value, "inputModalities"),
      ...reasoningEfforts(value.supportedReasoningEfforts),
    },
  };
}

function stringArrayProperty(
  record: Record<string, unknown>,
  key: string,
): { readonly inputModalities?: readonly string[] } {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return {};
  }
  return { inputModalities: value };
}

function reasoningEfforts(value: unknown): { readonly reasoningEfforts?: readonly string[] } {
  if (!Array.isArray(value)) {
    return {};
  }
  const efforts = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.reasoningEffort !== "string") {
      return [];
    }
    return [item.reasoningEffort];
  });
  return efforts.length > 0 ? { reasoningEfforts: efforts } : {};
}

function defaultModel(models: readonly RuntimeModel[]): { readonly defaultModel?: string } {
  const model = models.find((candidate) => candidate.isDefault);
  return model ? { defaultModel: model.id } : {};
}

function classifyCodexError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
} {
  if (error instanceof CodexModelResponseError) {
    return { code: "invalid_model_catalog", message: error.message };
  }
  if (error instanceof JsonRpcWebSocketUnixClientError && error.code === "request_timeout") {
    return { code: "timeout", message: error.message };
  }
  if (error instanceof CodexAppServerControllerError) {
    return {
      code: "codex_app_server_unavailable",
      message: error.message,
      hint: "Check that Codex app-server can start, then retry model discovery.",
    };
  }
  return {
    code: "model_discovery_failed",
    message: error instanceof Error ? error.message : "Codex model discovery failed.",
  };
}

class CodexModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexModelResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
