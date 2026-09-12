import * as fs from "fs";
import { writeAtomicText } from "./atomic-text.js";

export function writeJson(filePath: string, value: unknown): void {
  writeAtomicText(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
