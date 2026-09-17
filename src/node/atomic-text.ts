import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "node:crypto";

export function writeAtomicText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Each call owns its sibling temp file, including writers on same-PID workers.
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, text);
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup; surface the original write/rename error.
    }
    throw error;
  }
}
