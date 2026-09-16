import type { CliContext } from "./cli.js";

export function testLog(): CliContext["log"] & {
  lines: { level: string; message: string }[];
} {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    log: (message?: unknown) => lines.push({ level: "log", message: String(message) }),
    warn: (message?: unknown) => lines.push({ level: "warn", message: String(message) }),
    error: (message?: unknown) => lines.push({ level: "error", message: String(message) }),
  };
}
