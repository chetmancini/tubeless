import { constants } from "node:fs";
import { lstat, open, realpath, mkdir, unlink } from "node:fs/promises";
import { relative, resolve, isAbsolute, dirname } from "node:path";
import { CHECK_REPORT_LIMITS, type CheckReportResult } from "../utilities/check-report.js";
import { isNodeCheckReportPath } from "../utilities/node-check-plan.js";

const contained = (root: string, file: string): boolean => {
  const path = relative(root, file).replaceAll("\\", "/");
  return Boolean(path) && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
};

/** Removes old output before execution. Symlinks and non-directories are rejected. */
export async function prepareCheckReport(root: string, path: string): Promise<void> {
  if (!isNodeCheckReportPath(path)) throw new TypeError("Invalid report path.");
  const directory = resolve(root, ".tubeless-reports");
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Report directory must be a real directory.");
  const file = resolve(root, path);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Report must be a regular file.");
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Bounded read from the original execution directory, never a log parser. */
export async function readCheckReportFile(
  root: string,
  path: string
): Promise<{ content: string } | { result: CheckReportResult }> {
  if (!isNodeCheckReportPath(path)) return { result: { state: "malformed" } };
  return readBoundedCheckFile(root, path, CHECK_REPORT_LIMITS.inputBytes);
}

/** Read a trusted relative label beneath a real directory with a hard byte bound. */
export async function readBoundedCheckFile(
  root: string,
  path: string,
  maxBytes: number
): Promise<{ content: string } | { result: CheckReportResult }> {
  let handle;
  try {
    const base = await realpath(root),
      file = resolve(base, path);
    if (!(await lstat(dirname(file))).isDirectory()) return { result: { state: "malformed" } };
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    const actual = await realpath(
      process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : file
    );
    if (!stat.isFile() || !contained(base, actual)) return { result: { state: "malformed" } };
    if (stat.size > maxBytes) return { result: { state: "oversized" } };
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > maxBytes) return { result: { state: "oversized" } };
    return { content: bytes.subarray(0, size).toString("utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { result: { state: code === "ENOENT" ? "missing" : "malformed" } };
  } finally {
    await handle?.close();
  }
}
