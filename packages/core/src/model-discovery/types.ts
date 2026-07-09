import type { HeadlessAgentRuntimeConfig } from "../runtime/types.ts";

export type RuntimeModelKind = "model" | "alias" | "router";

export type RuntimeModel = {
  readonly id: string;
  readonly kind: RuntimeModelKind;
  readonly displayName?: string;
  readonly provider?: string;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly inputModalities?: readonly string[];
  readonly reasoningEfforts?: readonly string[];
};

export type RuntimeModelCatalogStatus = "available" | "partial" | "unavailable" | "unsupported";

export type RuntimeModelCatalogError = {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
};

export type RuntimeModelCatalog = {
  readonly runtime: string;
  readonly displayName: string;
  readonly status: RuntimeModelCatalogStatus;
  readonly source: string;
  readonly discoveredAt: string;
  readonly cliVersion?: string;
  readonly defaultModel?: string;
  readonly models: readonly RuntimeModel[];
  readonly error?: RuntimeModelCatalogError;
};

export type RuntimeModelsReport = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly runtimes: readonly RuntimeModelCatalog[];
};

export type RuntimeModelReaderInput = {
  readonly runtime: HeadlessAgentRuntimeConfig;
  readonly workspaceRoot: string;
  readonly orchestratorDir?: string;
  readonly timeoutMs: number;
  readonly now: Date;
};

export type RuntimeModelReader = {
  readonly runtimeIds: readonly string[];
  read(input: RuntimeModelReaderInput): Promise<RuntimeModelCatalog>;
};
