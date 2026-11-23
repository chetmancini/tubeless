import { setTimeout as delay } from "node:timers/promises";
import type { CloudCredentialStore } from "./credentials.js";
import { CloudClientError } from "./protocol.js";
import { errorMessage, terminalSafeText, type WorkbenchCliIo } from "../workbench-shared.js";

/** Small I/O seams keep CLI tests away from production and the machine keychain. */
export interface CloudCommandDependencies {
  fetch?: typeof globalThis.fetch;
  store?: CloudCredentialStore;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  openBrowser?: (url: string) => Promise<void>;
  readStdin?: () => Promise<string>;
}

export async function cloudSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}

export function cloudErrorExit(
  error: unknown,
  io: WorkbenchCliIo,
  signal: AbortSignal,
  report = true
): number {
  if (signal.aborted) {
    if (report) io.stderr.write("Stopped following Cloud activity. Remote work continues.\n");
    return 7;
  }
  if (report) io.stderr.write(`Error: ${terminalSafeText(errorMessage(error))}\n`);
  if (error instanceof CloudClientError) {
    if (error.code === "invalid_request") return 4;
    if (["conflict", "quota_exceeded", "unavailable", "rate_limited"].includes(error.code))
      return 6;
  }
  return 2;
}
