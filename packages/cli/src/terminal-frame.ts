export function renderWatchFrame(rendered: string, previousLineCount: number): string {
  const moveToFrameStart = previousLineCount > 0 ? `\x1b[${previousLineCount}A\r` : "\r";
  return `\x1b[?25l${moveToFrameStart}${clearRenderedLines(rendered)}\x1b[J\x1b[?25h`;
}

export function countRenderedLines(rendered: string, columns: number | undefined): number {
  const withoutTrailingNewline = rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
  if (!withoutTrailingNewline) {
    return 0;
  }

  return withoutTrailingNewline
    .split("\n")
    .reduce((count, line) => count + countPhysicalLines(line, columns), 0);
}

export function terminalColumns(): number | undefined {
  return process.stdout.isTTY ? process.stdout.columns : undefined;
}

function clearRenderedLines(rendered: string): string {
  const endsWithNewline = rendered.endsWith("\n");
  const lines = endsWithNewline ? rendered.slice(0, -1).split("\n") : rendered.split("\n");
  const cleared = lines.map((line) => `\r\x1b[2K${line}`).join("\r\n");
  return endsWithNewline ? `${cleared}\r\n` : cleared;
}

function countPhysicalLines(line: string, columns: number | undefined): number {
  if (!columns || columns <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(line.length / columns));
}
