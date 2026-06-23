import { resolve } from "node:path";
import { type CommonOptions, requireValue } from "./primitives.ts";

export type CommonOptionParseResult = { matched: true; nextIndex: number } | { matched: false };

export function parseCommonOption(
  args: readonly string[],
  index: number,
  common: CommonOptions,
): CommonOptionParseResult {
  const arg = args[index];
  switch (arg) {
    case "--workspace":
      common.workspaceRoot = resolve(requireValue(args, index + 1, arg));
      return { matched: true, nextIndex: index + 1 };
    case "--orchestrator-dir":
      common.orchestratorDir = resolve(requireValue(args, index + 1, arg));
      return { matched: true, nextIndex: index + 1 };
    case "--config":
      common.configPath = resolve(requireValue(args, index + 1, arg));
      return { matched: true, nextIndex: index + 1 };
    case "--json":
      common.json = true;
      return { matched: true, nextIndex: index };
    default:
      return { matched: false };
  }
}
