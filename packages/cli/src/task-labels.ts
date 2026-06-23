import { basename } from "node:path";

export function workspaceName(workspaceRoot: string): string {
  return basename(workspaceRoot) || workspaceRoot;
}

export function summarizeTaskPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "";
  }
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}
