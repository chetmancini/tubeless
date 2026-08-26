import * as fs from "fs";
import * as path from "path";

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Write to a sibling temp file and rename over the destination rather than
  // writeFileSync-ing the target directly: a crash mid-write would otherwise
  // leave truncated JSON. Rename is atomic on the same filesystem (same pattern
  // as openCheckpoint flush).
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
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

export function readJson<T>(filePath: string): T {
  // SAFETY: the caller's type parameter T is the contract for the file's
  // contents; the file is expected to hold JSON matching T (files written by
  // writeJson round-trip). JSON.parse returns `any`, so the assertion only
  // documents the caller's guarantee — it performs no runtime narrowing.
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function resetDir(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}
