import { TaskSendMessageError } from "./executors/types.ts";
import type { TaskOperation } from "./types.ts";

export function assertSuccessfulCodexTurnOperation(operation: TaskOperation): void {
  if (operation.status === "succeeded") {
    return;
  }
  throw new TaskSendMessageError(
    failureReasonForOperation(operation),
    operation.error ??
      `Codex app-server turn operation "${operation.operationId}" ended as ${operation.status}.`,
  );
}

export function assertCodexGoalOperationDidNotFail(operation: TaskOperation): void {
  if (operation.status !== "failed" && operation.status !== "interrupted") {
    return;
  }
  throw new TaskSendMessageError(
    failureReasonForOperation(operation),
    operation.error ??
      `Codex app-server goal operation "${operation.operationId}" ended as ${operation.status}.`,
  );
}

function failureReasonForOperation(operation: TaskOperation): "interrupted" | "provider_rejected" {
  return operation.status === "interrupted" ? "interrupted" : "provider_rejected";
}
