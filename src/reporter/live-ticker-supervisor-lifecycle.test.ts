import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createLiveTicker, SPINNER_TOKEN, type LiveTicker } from "./live-ticker.js";
import { waitForFileContent } from "./live-ticker.test-support.js";

describe("live ticker supervisor: shutdown and liveness", () => {
  it("does not interleave delayed worker output after a timed-out dispose", async () => {
    const path = join(tmpdir(), `tubeless-ticker-stop-timeout-${process.pid}-${Date.now()}.log`);
    const beatPath = join(
      tmpdir(),
      `tubeless-ticker-stop-timeout-beat-${process.pid}-${Date.now()}.txt`
    );
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-stop-timeout-worker-${process.pid}-${Date.now()}.mjs`
    );
    writeFileSync(
      workerPath,
      `
import { writeFileSync, writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const beat = ${JSON.stringify(beatPath)};
const handshake = new Int32Array(workerData.handshakeBuffer);
const pulse = () => {
  writeFileSync(beat, String(Date.now()));
  Atomics.add(handshake, 3, 1);
};
setInterval(pulse, 10);

parentPort.on("message", (msg) => {
  if (msg.type === "lines") {
    writeSync(workerData.fd, "worker-ready\\n");
    parentPort.postMessage({ type: "ready" });
    return;
  }
  if (msg.type !== "stop") return;
  const start = Date.now();
  while (Date.now() - start < 800) {
    pulse();
  }
  writeSync(workerData.fd, "late-worker-output\\n");
  Atomics.store(new Int32Array(workerData.handshakeBuffer), 0, 1);
  Atomics.notify(new Int32Array(workerData.handshakeBuffer), 0);
});
`
    );
    writeFileSync(beatPath, "0");
    const fd = openSync(path, "w");
    let workerAliveAtFinalPaint = false;
    let ticker: LiveTicker | undefined;
    try {
      ticker = createLiveTicker({
        color: true,
        columns: 80,
        fd,
        refreshIntervalMs: 20,
        unicode: false,
        workerUrl: pathToFileURL(workerPath),
        write: (chunk) => {
          writeSync(fd, chunk);
          if (!chunk.includes("final-status")) return;
          try {
            workerAliveAtFinalPaint = Date.now() - Number(readFileSync(beatPath, "utf8")) < 80;
          } catch {
            workerAliveAtFinalPaint = false;
          }
        },
      });
      ticker.setLines(["final-status"]);

      await waitForFileContent(path, (next) => next.includes("worker-ready"));

      ticker.dispose();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("final-status");
      expect(rendered).not.toContain("late-worker-output");
      expect(workerAliveAtFinalPaint).toBe(false);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
      unlinkSync(beatPath);
    }
  });

  it("does not treat a slow refresh beat as isolate death", async () => {
    // Handshake beats every 200ms, then stop blocks for 800ms without pulsing.
    // An 80ms quiet-beat join would paint mid-hang; isolate exit must win.

    const path = join(tmpdir(), `tubeless-ticker-slow-beat-${process.pid}-${Date.now()}.log`);
    const beatPath = join(
      tmpdir(),
      `tubeless-ticker-slow-beat-alive-${process.pid}-${Date.now()}.txt`
    );
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-slow-beat-worker-${process.pid}-${Date.now()}.mjs`
    );
    writeFileSync(
      workerPath,
      `
import { writeFileSync, writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const beat = ${JSON.stringify(beatPath)};
const handshake = new Int32Array(workerData.handshakeBuffer);
setInterval(() => {
  Atomics.add(handshake, 3, 1);
}, 200);
setInterval(() => {
  writeFileSync(beat, String(Date.now()));
}, 10);

parentPort.on("message", (msg) => {
  if (msg.type === "lines") {
    writeSync(workerData.fd, "worker-ready\\n");
    parentPort.postMessage({ type: "ready" });
    return;
  }
  if (msg.type !== "stop") return;
  const start = Date.now();
  while (Date.now() - start < 800) {
    writeFileSync(beat, String(Date.now()));
  }
  writeSync(workerData.fd, "late-worker-output\\n");
});
`
    );
    writeFileSync(beatPath, "0");
    const fd = openSync(path, "w");
    let workerAliveAtFinalPaint = false;
    let ticker: LiveTicker | undefined;
    try {
      ticker = createLiveTicker({
        color: true,
        columns: 80,
        fd,
        refreshIntervalMs: 200,
        unicode: false,
        workerUrl: pathToFileURL(workerPath),
        write: (chunk) => {
          writeSync(fd, chunk);
          if (!chunk.includes("final-status")) return;
          try {
            workerAliveAtFinalPaint = Date.now() - Number(readFileSync(beatPath, "utf8")) < 80;
          } catch {
            workerAliveAtFinalPaint = false;
          }
        },
      });
      ticker.setLines(["final-status"]);

      await waitForFileContent(path, (next) => next.includes("worker-ready"));

      ticker.dispose();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("final-status");
      expect(rendered).not.toContain("late-worker-output");
      expect(workerAliveAtFinalPaint).toBe(false);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
      unlinkSync(beatPath);
    }
  });

  it("does not spin a full second waiting for a promptly terminated worker", async () => {
    const path = join(tmpdir(), `tubeless-ticker-stop-wait-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-stop-wait-worker-${process.pid}-${Date.now()}.mjs`
    );
    writeFileSync(
      workerPath,
      `
import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

parentPort.on("message", (msg) => {
  if (msg.type === "lines") {
    writeSync(workerData.fd, "worker-ready\\n");
    parentPort.postMessage({ type: "ready" });
  }
});
`
    );
    const fd = openSync(path, "w");
    let ticker: LiveTicker | undefined;
    try {
      ticker = createLiveTicker({
        color: true,
        columns: 80,
        fd,
        refreshIntervalMs: 20,
        unicode: false,
        workerUrl: pathToFileURL(workerPath),
        write: (chunk) => {
          writeSync(fd, chunk);
        },
      });
      ticker.setLines(["final-status"]);

      await waitForFileContent(path, (next) => next.includes("worker-ready"));

      const started = Date.now();
      ticker.dispose();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(1_200);
      expect(readFileSync(path, "utf8")).toContain("final-status");
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("does not spin when disposing a supervisor that never started", async () => {
    // Supervisor boot failure never sets control[1]. dispose of the inline
    // fallback must not park on the isolate join or ownership drain.
    const path = join(tmpdir(), `tubeless-ticker-supervisor-boot-${process.pid}-${Date.now()}.log`);
    const supervisorPath = join(
      tmpdir(),
      `tubeless-ticker-supervisor-boot-${process.pid}-${Date.now()}.js`
    );
    writeFileSync(supervisorPath, 'throw new Error("supervisor boot failure");\n');
    const fd = openSync(path, "w");
    const inlineWrites: string[] = [];
    let ticker: LiveTicker | undefined;
    try {
      ticker = createLiveTicker({
        color: true,
        columns: 80,
        fd,
        refreshIntervalMs: 20,
        unicode: false,
        supervisorUrl: pathToFileURL(supervisorPath),
        write: (chunk) => {
          inlineWrites.push(chunk);
          writeSync(fd, chunk);
        },
      });
      try {
        ticker.setLines([`${SPINNER_TOKEN} load`]);
      } catch {
        // Supervisor may already be gone; fallback still paints on error/exit.
      }

      await vi.waitFor(() => {
        expect(inlineWrites.some((chunk) => chunk.includes("load"))).toBe(true);
      });
      expect(inlineWrites.join("")).toContain("load");

      const started = Date.now();
      ticker.dispose();
      expect(Date.now() - started).toBeLessThan(400);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(supervisorPath);
    }
  });

  it("still drains after a supervisor crash once the isolate has started", async () => {
    // Supervisor error/exit after the isolate published a beat is not
    // "never started". dispose must still wait out the ownership window.
    const path = join(
      tmpdir(),
      `tubeless-ticker-supervisor-midflight-${process.pid}-${Date.now()}.log`
    );
    const beatPath = join(
      tmpdir(),
      `tubeless-ticker-supervisor-midflight-beat-${process.pid}-${Date.now()}.txt`
    );
    const supervisorPath = join(
      tmpdir(),
      `tubeless-ticker-supervisor-midflight-${process.pid}-${Date.now()}.mjs`
    );
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-supervisor-midflight-worker-${process.pid}-${Date.now()}.mjs`
    );
    writeFileSync(
      supervisorPath,
      `
import { parentPort, workerData, Worker } from "node:worker_threads";
const ticker = new Worker(new URL(workerData.tickerUrl), {
  execArgv: workerData.execArgv,
  workerData: workerData.tickerData,
});
ticker.on("message", (msg) => {
  parentPort.postMessage(msg);
  // Exit after the isolate acks lines. A timer from the parent's
  // first "lines" post can kill a nested worker before it boots.
  if (msg.type === "ready") process.exit(1);
});
ticker.unref();
parentPort.on("message", (msg) => {
  ticker.postMessage(msg);
});
`
    );
    writeFileSync(
      workerPath,
      `
import { writeFileSync, writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
const beat = ${JSON.stringify(beatPath)};
const handshake = new Int32Array(workerData.handshakeBuffer);
const pulse = () => {
  writeFileSync(beat, String(Date.now()));
  Atomics.add(handshake, 3, 1);
};
pulse();
setInterval(pulse, 10);
// Nested isolate boot can lag the parent's first "lines" post.
setTimeout(() => {
  parentPort.on("message", (msg) => {
    if (msg.type !== "lines") return;
    writeSync(workerData.fd, "worker-ready\\n");
    parentPort.postMessage({ type: "ready" });
  });
}, 80);
`
    );
    writeFileSync(beatPath, "0");
    const fd = openSync(path, "w");
    const inlineWrites: string[] = [];
    let ticker: LiveTicker | undefined;
    try {
      ticker = createLiveTicker({
        color: true,
        columns: 80,
        fd,
        refreshIntervalMs: 20,
        unicode: false,
        supervisorUrl: pathToFileURL(supervisorPath),
        workerUrl: pathToFileURL(workerPath),
        write: (chunk) => {
          inlineWrites.push(chunk);
          writeSync(fd, chunk);
        },
      });
      ticker.setLines(["load"]);

      await waitForFileContent(path, (next) => next.includes("worker-ready"));
      expect(readFileSync(path, "utf8")).toContain("worker-ready");
      // Wait for the inline fallback paint: it proves the parent observed
      // the supervisor exit, so dispose takes the fallback path
      // (ownership-window drain) instead of racing Worker exit and parking
      // on the stop handshake plus isolate join. A fixed 80ms sleep raced
      // on Node 24 CI and parked dispose for ~1660ms.
      await vi.waitFor(
        () => {
          expect(inlineWrites.some((chunk) => chunk.includes("load"))).toBe(true);
        },
        { interval: 25, timeout: 5_000 }
      );

      const started = Date.now();
      ticker.dispose();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1_400);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(beatPath);
      unlinkSync(supervisorPath);
      unlinkSync(workerPath);
    }
  });
});
