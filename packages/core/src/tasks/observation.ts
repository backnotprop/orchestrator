import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readTaskHeartbeat } from "./store.ts";
import { isTerminalTaskStatus, taskDisplayState } from "./types.ts";
import type {
  AgentTaskRecord,
  ProviderTaskHealthLookup,
  TaskObservation,
  ProviderTaskSupervision,
  TaskProcessIdentity,
  TaskStoreOptions,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const NO_SUPERVISION_STARTUP_GRACE_MS = 20_000;

export async function captureProcessIdentity(
  pid: number,
): Promise<TaskProcessIdentity | undefined> {
  if (!(await isPidAlive(pid))) {
    return undefined;
  }

  const startedAtMs = await readProcessStartedAtMs(pid);
  return {
    pid,
    capturedAt: now(),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
}

export async function observeTaskState(
  _input: TaskStoreOptions,
  task: AgentTaskRecord,
  options: { now?: Date; providerHealth?: ProviderTaskHealthLookup } = {},
): Promise<TaskObservation> {
  const checkedAt = (options.now ?? new Date()).toISOString();
  if (isTerminalTaskStatus(task.status)) {
    return observation(task, task.status, checkedAt);
  }

  const baseState = taskDisplayState(task);
  if (!task.supervision) {
    if (baseState === "queued" || baseState === "starting") {
      return observation(task, baseState, checkedAt, {
        reason: "legacy/unverified supervision",
      });
    }
    const referenceAt = task.startedAt ?? task.createdAt;
    if (isFreshHeartbeat(referenceAt, NO_SUPERVISION_STARTUP_GRACE_MS, options.now)) {
      return observation(task, baseState, checkedAt, {
        reason: "awaiting supervision heartbeat",
      });
    }
    return observation(task, "stale", checkedAt, {
      reason: "legacy/unverified supervision",
    });
  }

  if (task.supervision.kind === "provider") {
    return await observeProviderTask(task, task.supervision, checkedAt, options);
  }

  const heartbeat = await readTaskHeartbeat(task.paths);
  const staleAfterMs = task.supervision.staleAfterMs;
  const heartbeatAt = heartbeat?.lastHeartbeatAt ?? task.supervision.startedAt;
  if (isFreshHeartbeat(heartbeatAt, staleAfterMs, options.now)) {
    return observation(task, baseState, checkedAt, {
      heartbeat: {
        lastHeartbeatAt: heartbeatAt,
        staleAfterMs,
      },
    });
  }

  const supervisor = await verifyProcessIdentity(task.supervision.supervisor);
  if (supervisor.verified) {
    return observation(task, "stale", checkedAt, {
      reason: "watcher heartbeat is stale",
      heartbeat: {
        ...(heartbeat?.lastHeartbeatAt ? { lastHeartbeatAt: heartbeat.lastHeartbeatAt } : {}),
        staleAfterMs,
      },
      liveness: {
        supervisorAlive: true,
        supervisorVerified: true,
      },
    });
  }

  if (task.supervision.child) {
    const child = await verifyProcessIdentity(task.supervision.child);
    if (child.verified) {
      return observation(task, "orphaned", checkedAt, {
        reason: "watcher gone, child still alive",
        heartbeat: {
          ...(heartbeat?.lastHeartbeatAt ? { lastHeartbeatAt: heartbeat.lastHeartbeatAt } : {}),
          staleAfterMs,
        },
        liveness: {
          supervisorAlive: supervisor.alive,
          supervisorVerified: false,
          childAlive: true,
          childVerified: true,
        },
      });
    }

    if (child.alive) {
      return observation(task, "stale", checkedAt, {
        reason: "child process identity is unverified",
        heartbeat: {
          ...(heartbeat?.lastHeartbeatAt ? { lastHeartbeatAt: heartbeat.lastHeartbeatAt } : {}),
          staleAfterMs,
        },
        liveness: {
          supervisorAlive: supervisor.alive,
          supervisorVerified: false,
          childAlive: true,
          childVerified: false,
        },
      });
    }
  }

  return observation(task, "lost", checkedAt, {
    reason: "watcher gone, child gone, final outcome unknown",
    heartbeat: {
      ...(heartbeat?.lastHeartbeatAt ? { lastHeartbeatAt: heartbeat.lastHeartbeatAt } : {}),
      staleAfterMs,
    },
    liveness: {
      supervisorAlive: supervisor.alive,
      supervisorVerified: false,
      ...(task.supervision.child
        ? {
            childAlive: false,
            childVerified: false,
          }
        : {}),
    },
  });
}

async function observeProviderTask(
  task: AgentTaskRecord,
  supervision: ProviderTaskSupervision,
  checkedAt: string,
  options: { providerHealth?: ProviderTaskHealthLookup },
): Promise<TaskObservation> {
  const baseState = taskDisplayState(task);
  if (!options.providerHealth) {
    return observation(task, baseState, checkedAt);
  }

  try {
    const health = await options.providerHealth(task, supervision);
    if (health.reachable) {
      return observation(task, baseState, health.checkedAt ?? checkedAt, {
        heartbeat: {
          ...((health.checkedAt ?? supervision.lastVerifiedAt)
            ? { lastHeartbeatAt: health.checkedAt ?? supervision.lastVerifiedAt }
            : {}),
          staleAfterMs: supervision.staleAfterMs,
        },
      });
    }
    return observation(task, "stale", health.checkedAt ?? checkedAt, {
      reason: health.reason ?? "provider app-server unavailable",
      heartbeat: {
        ...((health.checkedAt ?? supervision.lastVerifiedAt)
          ? { lastHeartbeatAt: health.checkedAt ?? supervision.lastVerifiedAt }
          : {}),
        staleAfterMs: supervision.staleAfterMs,
      },
    });
  } catch (error) {
    return observation(task, "stale", checkedAt, {
      reason: error instanceof Error ? error.message : "provider app-server unavailable",
      heartbeat: {
        ...(supervision.lastVerifiedAt ? { lastHeartbeatAt: supervision.lastVerifiedAt } : {}),
        staleAfterMs: supervision.staleAfterMs,
      },
    });
  }
}

function observation(
  task: AgentTaskRecord,
  state: TaskObservation["state"],
  checkedAt: string,
  details: Omit<TaskObservation, "status" | "state" | "active" | "actionable" | "checkedAt"> = {},
): TaskObservation {
  const active =
    state === "queued" ||
    state === "starting" ||
    state === "running" ||
    state === "stopping" ||
    state === "stale" ||
    state === "orphaned";
  const actionable =
    state === "queued" || state === "starting" || state === "running" || state === "stopping";
  return {
    status: task.status,
    state,
    active,
    actionable,
    checkedAt,
    ...details,
  };
}

function isFreshHeartbeat(
  lastHeartbeatAt: string,
  staleAfterMs: number,
  now: Date | undefined,
): boolean {
  const heartbeatMs = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return false;
  }
  return (now ?? new Date()).getTime() - heartbeatMs <= staleAfterMs;
}

async function verifyProcessIdentity(identity: TaskProcessIdentity): Promise<{
  alive: boolean;
  verified: boolean;
}> {
  if (!(await isPidAlive(identity.pid))) {
    return { alive: false, verified: false };
  }

  if (identity.startedAtMs === undefined) {
    return { alive: true, verified: false };
  }

  const currentStartedAtMs = await readProcessStartedAtMs(identity.pid);
  return {
    alive: true,
    verified:
      currentStartedAtMs !== undefined &&
      Math.abs(currentStartedAtMs - identity.startedAtMs) < 1000,
  };
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    return true;
  }
}

async function readProcessStartedAtMs(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
    const timestamp = stdout.trim();
    if (!timestamp) {
      return undefined;
    }
    const startedAtMs = Date.parse(timestamp);
    return Number.isFinite(startedAtMs) ? startedAtMs : undefined;
  } catch (error) {
    if (isNoSuchProcess(error) || isProcessLookupFailure(error)) {
      return undefined;
    }
    return undefined;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isProcessLookupFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === 1;
}

function now(): string {
  return new Date().toISOString();
}
