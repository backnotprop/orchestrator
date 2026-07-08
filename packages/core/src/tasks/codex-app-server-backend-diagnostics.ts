import { readFile, stat } from "node:fs/promises";

const BACKEND_DIAGNOSTIC_MAX_BYTES = 16_000;

export type CodexAppServerBackendDiagnostic = {
  kind: "protocol.backend.auth_required" | "protocol.backend.fatal";
  code: "authorization_required" | "fatal";
  message: string;
  severity: "error";
  logPath: string;
};

export async function readCodexAppServerBackendDiagnostic(
  stderrLogPath: string | undefined,
  options: { fromOffset?: number } = {},
): Promise<CodexAppServerBackendDiagnostic | undefined> {
  if (!stderrLogPath) {
    return undefined;
  }

  const stderr = await readTailIfExists(
    stderrLogPath,
    BACKEND_DIAGNOSTIC_MAX_BYTES,
    options.fromOffset,
  );
  if (!stderr) {
    return undefined;
  }

  if (/\bAuthorizationRequired\b/.test(stderr)) {
    return {
      kind: "protocol.backend.auth_required",
      code: "authorization_required",
      severity: "error",
      message:
        "Codex app-server backend reported AuthorizationRequired. Check Codex app-server tool or MCP authentication.",
      logPath: stderrLogPath,
    };
  }

  if (/\bfatal\b/i.test(stderr)) {
    return {
      kind: "protocol.backend.fatal",
      code: "fatal",
      severity: "error",
      message: "Codex app-server backend reported a fatal error. Inspect backend stderr.",
      logPath: stderrLogPath,
    };
  }

  return undefined;
}

export async function codexAppServerBackendDiagnosticOffset(
  stderrLogPath: string | undefined,
): Promise<number | undefined> {
  if (!stderrLogPath) {
    return undefined;
  }

  try {
    return (await stat(stderrLogPath)).size;
  } catch (error) {
    if (isMissingFile(error)) {
      return 0;
    }
    throw error;
  }
}

async function readTailIfExists(
  path: string,
  maxBytes: number,
  fromOffset: number | undefined,
): Promise<string> {
  try {
    const fileStat = await stat(path);
    const contents = await readFile(path);
    const lowerBound = fromOffset === undefined ? 0 : Math.min(fromOffset, contents.byteLength);
    const tailStart = Math.max(lowerBound, contents.byteLength - maxBytes);

    if (fileStat.size <= maxBytes && lowerBound === 0) {
      return contents.toString("utf8");
    }

    return contents.subarray(tailStart).toString("utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return "";
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
