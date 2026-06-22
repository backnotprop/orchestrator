import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { HeadlessAgentRuntimeConfig, RuntimeRegistry } from "@backnotprop/orchestrator-core";

export type RuntimeDoctorCheck = {
  id: string;
  displayName: string;
  executable: string;
  available: boolean;
  path?: string;
  message: string;
};

export async function doctorRuntimeAvailability(
  registry: RuntimeRegistry,
  options: {
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<RuntimeDoctorCheck[]> {
  const runtimes = Object.values(registry)
    .filter(isEnabledRuntime)
    .sort((left, right) => left.id.localeCompare(right.id));

  return await Promise.all(
    runtimes.map(async (runtime) => {
      const executable = runtime.launch.executable;
      const foundPath = await findExecutable(executable, {
        cwd: options.cwd,
        env: options.env ?? process.env,
      });
      return {
        id: runtime.id,
        displayName: runtime.displayName,
        executable,
        available: Boolean(foundPath),
        ...(foundPath ? { path: foundPath } : {}),
        message: foundPath
          ? `Found ${executable}.`
          : `Executable ${executable} was not found on PATH.`,
      };
    }),
  );
}

function isEnabledRuntime(
  runtime: HeadlessAgentRuntimeConfig | undefined,
): runtime is HeadlessAgentRuntimeConfig {
  return Boolean(runtime?.enabled);
}

async function findExecutable(
  executable: string,
  options: {
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
  },
): Promise<string | undefined> {
  for (const candidate of executableCandidates(executable, options)) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function executableCandidates(
  executable: string,
  options: {
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
  },
): string[] {
  if (isPathLikeExecutable(executable)) {
    return executablePathVariants(resolve(options.cwd, executable), options.env);
  }

  const pathEntries = (options.env.PATH ?? "").split(delimiter).filter(Boolean);
  return pathEntries.flatMap((entry) =>
    executablePathVariants(join(entry, executable), options.env),
  );
}

function executablePathVariants(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (process.platform !== "win32" || /\.[^\\/]+$/.test(path)) {
    return [path];
  }

  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return extensions.map((extension) => `${path}${extension.toLowerCase()}`);
}

function isPathLikeExecutable(executable: string): boolean {
  return isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
