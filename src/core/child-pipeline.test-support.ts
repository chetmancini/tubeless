import type { ReporterOutput } from "../reporter/interactive-reporter.js";

export function captureOutput(): ReporterOutput & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    columns: 100,
    isTTY: true,
    write: (chunk) => chunks.push(chunk),
  };
}

export function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal === undefined) return;
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}
