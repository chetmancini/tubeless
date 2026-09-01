import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

const SHOW_CURSOR = "\u001B[?25h";
const compiledWorker = new URL("../dist/live-ticker-worker.js", import.meta.url);

const workers: Array<{ fd: number; path: string; worker: Worker }> = [];

afterEach(async () => {
  await Promise.all(
    workers.splice(0).map(async ({ fd, path, worker }) => {
      await worker.terminate().catch(() => undefined);
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(path);
      } catch {}
    })
  );
});

function startWorker(): {
  fd: number;
  handshake: Int32Array;
  path: string;
  worker: Worker;
} {
  const path = join(
    tmpdir(),
    `tubeless-ticker-worker-${process.pid}-${Date.now()}-${Math.random()}.log`
  );
  const fd = openSync(path, "w");
  const handshakeBuffer = new SharedArrayBuffer(16);
  const handshake = new Int32Array(handshakeBuffer);
  const worker = new Worker(compiledWorker, {
    workerData: {
      color: false,
      columns: 80,
      fd,
      handshakeBuffer,
      refreshIntervalMs: 50,
      unicode: false,
    },
  });
  workers.push({ fd, path, worker });
  return { fd, handshake, path, worker };
}

async function waitForFile(
  path: string,
  predicate: (rendered: string) => boolean
): Promise<string> {
  let rendered = "";
  await vi.waitFor(
    () => {
      rendered = readFileSync(path, "utf8");
      expect(predicate(rendered)).toBe(true);
    },
    { interval: 25, timeout: 1_000 }
  );
  return rendered;
}

describe("live-ticker-worker protocol", () => {
  it("paints a lines frame to the fd", async () => {
    const { path, worker } = startWorker();
    worker.postMessage({ lines: ["hello-frame"], type: "lines" });
    await waitForFile(path, (rendered) => rendered.includes("hello-frame"));
  });

  it("writes log text and clears the previous frame", async () => {
    const { path, worker } = startWorker();
    worker.postMessage({ lines: ["hello-frame"], type: "lines" });
    await waitForFile(path, (rendered) => rendered.includes("hello-frame"));
    worker.postMessage({ text: "logged-from-test\n", type: "log" });
    const rendered = await waitForFile(path, (next) => next.includes("logged-from-test"));
    expect(rendered).toContain("\u001B[J");
  });

  it("stops with a handshake, cursor-show sequence, and exit 0", async () => {
    const { handshake, path, worker } = startWorker();
    const exited = new Promise<number>((resolve, reject) => {
      worker.once("exit", resolve);
      worker.once("error", reject);
    });
    worker.postMessage({ lines: ["hello-frame"], type: "lines" });
    await waitForFile(path, (rendered) => rendered.includes("hello-frame"));
    worker.postMessage({ type: "stop" });
    await vi.waitFor(() => expect(Atomics.load(handshake, 0)).toBe(1), {
      interval: 25,
      timeout: 1_000,
    });
    expect(await exited).toBe(0);
    expect(readFileSync(path, "utf8")).toContain(SHOW_CURSOR);
  });

  it("ignores an unknown message type and stays live for a later lines frame", async () => {
    const { handshake, path, worker } = startWorker();
    let exitCode: number | undefined;
    worker.once("exit", (code) => {
      exitCode = code;
    });
    const beat = Atomics.load(handshake, 3);
    worker.postMessage({ type: "unknown" });
    await vi.waitFor(() => expect(Atomics.load(handshake, 3)).toBeGreaterThan(beat), {
      interval: 25,
      timeout: 1_000,
    });
    expect(exitCode).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("");
    worker.postMessage({ lines: ["still-alive"], type: "lines" });
    await waitForFile(path, (rendered) => rendered.includes("still-alive"));
    expect(exitCode).toBeUndefined();
  });
});
