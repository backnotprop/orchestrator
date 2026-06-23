import { requireValue } from "./primitives.ts";

export function normalizeLeadingCommonOptions(argv: readonly string[]): string[] {
  const leading: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];

    if (arg === "--json") {
      leading.push(arg);
      index += 1;
      continue;
    }

    if (arg === "--workspace" || arg === "--orchestrator-dir" || arg === "--config") {
      leading.push(arg, requireValue(argv, index + 1, arg));
      index += 2;
      continue;
    }

    break;
  }

  if (leading.length === 0) {
    return [...argv];
  }

  if (index >= argv.length) {
    return ["help", ...leading];
  }

  return [argv[index], ...leading, ...argv.slice(index + 1)];
}
