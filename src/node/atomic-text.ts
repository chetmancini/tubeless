import * as fs from "fs";
import * as path from "path";

export function writeAtomicText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Rename a sibling temp file so readers see only complete writes.
  const tmpPath = `${filePath}.tmp-${process.pid}`;
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
