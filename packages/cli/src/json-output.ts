export function jsonLine(value: unknown, options: { compact?: boolean } = {}): string {
  return `${JSON.stringify(value, null, options.compact ? undefined : 2)}\n`;
}
