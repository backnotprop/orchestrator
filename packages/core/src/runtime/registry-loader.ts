import { resolve } from "node:path";
import {
  loadConfiguredRuntimeRegistry,
  type ConfiguredRuntimeRegistry,
  type OrchestratorConfigLoadOptions,
} from "./config.ts";

export type ConfiguredRuntimeRegistryLoaderOptions = Omit<
  OrchestratorConfigLoadOptions,
  "workspaceRoot"
>;

export type ConfiguredRuntimeRegistryLoader = {
  load(workspaceRoot: string): Promise<ConfiguredRuntimeRegistry>;
};

export function createConfiguredRuntimeRegistryLoader(
  options: ConfiguredRuntimeRegistryLoaderOptions = {},
): ConfiguredRuntimeRegistryLoader {
  const cache = new Map<string, Promise<ConfiguredRuntimeRegistry>>();

  return {
    async load(workspaceRoot) {
      const resolvedWorkspaceRoot = resolve(workspaceRoot);
      const cached = cache.get(resolvedWorkspaceRoot);
      if (cached) {
        return await cached;
      }

      const loaded = loadConfiguredRuntimeRegistry({
        ...options,
        workspaceRoot: resolvedWorkspaceRoot,
      });
      cache.set(resolvedWorkspaceRoot, loaded);
      return await loaded;
    },
  };
}
