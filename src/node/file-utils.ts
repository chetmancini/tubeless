import * as fs from "fs";
import { writeAtomicText } from "./atomic-text.js";

/** Serialize JSON and atomically replace the destination file. */
export function writeJson(filePath: string, value: unknown): void {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Value cannot be serialized as JSON");
  }
  writeAtomicText(filePath, `${serialized}\n`);
}

/** Read and parse trusted JSON without runtime schema validation. */
export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

/** Remove and recreate a directory for generated output. */
export function resetDir(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}
