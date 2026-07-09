import type {
  RuntimeModelCatalog,
  RuntimeModelCatalogError,
  RuntimeModelReaderInput,
} from "./types.ts";

export function availableCatalog(
  input: RuntimeModelReaderInput,
  details: Omit<RuntimeModelCatalog, "runtime" | "displayName" | "discoveredAt" | "status"> & {
    readonly status?: "available" | "partial";
  },
): RuntimeModelCatalog {
  return {
    runtime: input.runtime.id,
    displayName: input.runtime.displayName,
    status: details.status ?? "available",
    source: details.source,
    discoveredAt: input.now.toISOString(),
    ...(details.cliVersion ? { cliVersion: details.cliVersion } : {}),
    ...(details.defaultModel ? { defaultModel: details.defaultModel } : {}),
    models: details.models,
    ...(details.error ? { error: redactCatalogError(details.error) } : {}),
  };
}

export function unavailableCatalog(
  input: RuntimeModelReaderInput,
  details: {
    readonly source: string;
    readonly cliVersion?: string;
    readonly error: RuntimeModelCatalogError;
  },
): RuntimeModelCatalog {
  return {
    runtime: input.runtime.id,
    displayName: input.runtime.displayName,
    status: "unavailable",
    source: details.source,
    discoveredAt: input.now.toISOString(),
    ...(details.cliVersion ? { cliVersion: details.cliVersion } : {}),
    models: [],
    error: redactCatalogError(details.error),
  };
}

function redactCatalogError(error: RuntimeModelCatalogError): RuntimeModelCatalogError {
  return {
    code: error.code,
    message: error.message
      .replace(
        /\b(Bearer|token|access_token|refresh_token|api[_-]?key)\s+[\w./+=:-]+/gi,
        "$1 [redacted]",
      )
      .replace(/(access_token|refresh_token|api[_-]?key|token)=([^&\s]+)/gi, "$1=[redacted]"),
    ...(error.hint ? { hint: error.hint } : {}),
  };
}

export function unsupportedCatalog(
  input: RuntimeModelReaderInput,
  hint = "Omit --model and let the runtime choose its default.",
): RuntimeModelCatalog {
  return {
    runtime: input.runtime.id,
    displayName: input.runtime.displayName,
    status: "unsupported",
    source: "none",
    discoveredAt: input.now.toISOString(),
    models: [],
    error: {
      code: "model_discovery_unsupported",
      message: `Runtime "${input.runtime.id}" does not expose model discovery through Orchestrator.`,
      hint,
    },
  };
}
