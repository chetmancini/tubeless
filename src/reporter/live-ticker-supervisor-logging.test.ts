import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createLiveTicker, SPINNER_TOKEN, type LiveTicker } from "./live-ticker.js";
import { waitForFileContent } from "./live-ticker.test-support.js";

describe("live ticker supervisor: log delivery", () => {
  it("replays logs sent before the worker fails to boot", async () => {
    const path = join(tmpdir(), `tubeless-ticker-log-replay-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-log-replay-worker-${process.pid}-${Date.now()}.js`
    );
    writeFileSync(workerPath, 'throw new Error("boot failure");\n');
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
      ticker.setLines([`${SPINNER_TOKEN} load`]);
      ticker.writeLog("pre-fallback log\n");

      let rendered = await waitForFileContent(path, (next) => next.includes("pre-fallback log"));

      ticker.dispose();
      expect(rendered).toContain("pre-fallback log");
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("does not replay logs already accepted by a live worker", async () => {
    const path = join(tmpdir(), `tubeless-ticker-log-dup-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-log-dup-worker-${process.pid}-${Date.now()}.mjs`
    );
    writeFileSync(
      workerPath,
      `
import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

let logs = 0;
parentPort.on("message", (msg) => {
  if (msg.type === "lines") {
    writeSync(workerData.fd, "worker-live\\n");
    parentPort.postMessage({ type: "ready" });
    return;
  }
  if (msg.type !== "log") return;
  writeSync(workerData.fd, msg.text);
  logs += 1;
  Atomics.add(new Int32Array(workerData.handshakeBuffer), 2, 1);
  parentPort.postMessage({ type: "ack", kind: "log" });
  if (logs >= 2) throw new Error("mid-run crash");
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
      ticker.setLines([`${SPINNER_TOKEN} load`]);

      await waitForFileContent(path, (next) => next.includes("worker-live"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      ticker.writeLog("session-log\n");
      await waitForFileContent(path, (next) => next.includes("session-log"));

      ticker.writeLog("crash-log\n");
      let rendered = await waitForFileContent(
        path,
        (next) =>
          next.includes("crash-log") &&
          /[-\\|/] load/.test(next.replace(/\u001B\[[0-9;]*[A-Za-z]/g, ""))
      );

      ticker.dispose();
      rendered = readFileSync(path, "utf8");
      expect(rendered.match(/session-log/g)).toHaveLength(1);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("does not cursor-up when the worker never painted", async () => {
    const path = join(tmpdir(), `tubeless-ticker-no-paint-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-no-paint-worker-${process.pid}-${Date.now()}.js`
    );
    writeFileSync(workerPath, 'throw new Error("boot failure");\n');
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
      ticker.setLines([`${SPINNER_TOKEN} load`, `${SPINNER_TOKEN} more`]);

      const rendered = await waitForFileContent(
        path,
        (next) => next.includes("load") && /[-\\|/] /.test(next)
      );

      ticker.dispose();
      // Worker never painted, so the first fallback frame must not cursor-up.
      // Later inline refreshes may; ignore those.
      const loadAt = rendered.indexOf("load");
      expect(loadAt).toBeGreaterThan(-1);
      expect(rendered.slice(0, loadAt)).not.toMatch(/\u001B\[\d+F/);
      const firstFrame = rendered.slice(0, loadAt + "load".length);
      const plain = firstFrame.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
      expect(plain).toMatch(/[-\\|/] load/);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("restores the latest frame after replaying boot-failure logs", async () => {
    const path = join(tmpdir(), `tubeless-ticker-log-order-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-log-order-worker-${process.pid}-${Date.now()}.js`
    );
    writeFileSync(workerPath, 'throw new Error("boot failure");\n');
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
      ticker.writeLog("step done\n");
      ticker.setLines(["final status"]);

      let rendered = await waitForFileContent(
        path,
        (next) => next.includes("step done") && next.includes("final status")
      );

      ticker.dispose();
      rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("step done");
      expect(rendered).toContain("final status");
      expect(rendered.lastIndexOf("final status")).toBeGreaterThan(
        rendered.lastIndexOf("step done")
      );
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("paints the final frame when dispose races a crashed worker", async () => {
    const path = join(tmpdir(), `tubeless-ticker-dispose-final-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-dispose-final-worker-${process.pid}-${Date.now()}.mjs`
    );
    writeFileSync(
      workerPath,
      `
import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

parentPort.on("message", (msg) => {
  if (msg.type !== "lines") return;
  writeSync(workerData.fd, "\\u001B[?25lworker-stale-1\\nworker-stale-2\\n");
  Atomics.store(new Int32Array(workerData.handshakeBuffer), 1, 2);
  parentPort.postMessage({ type: "ready", frameLineCount: 2 });
  throw new Error("mid-run crash");
});
`
    );
    const fd = openSync(path, "w");
    try {
      const ticker = createLiveTicker({
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
      ticker.setLines(["dispose-final-1", "dispose-final-2"]);
      ticker.dispose();
      const rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("worker-stale-1");
      expect(rendered).toContain("dispose-final-1");
      expect(rendered).toContain("dispose-final-2");
      expect(rendered).toMatch(/worker-stale-2\n\u001B\[2F\u001B\[J/);
    } finally {
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("replays a log posted after ready when the worker crashes before writing it", async () => {
    const path = join(tmpdir(), `tubeless-ticker-log-ack-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-log-ack-worker-${process.pid}-${Date.now()}.mjs`
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
    return;
  }
  if (msg.type === "log") throw new Error("log crash");
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
      ticker.setLines(["load"]);

      await waitForFileContent(path, (next) => next.includes("worker-ready"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      ticker.writeLog("lost-log\n");
      let rendered = await waitForFileContent(path, (next) => next.includes("lost-log"));

      ticker.dispose();
      rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("lost-log");
      expect(rendered.match(/lost-log/g)).toHaveLength(1);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("does not replay a log the worker wrote when the ack message is lost", async () => {
    const path = join(tmpdir(), `tubeless-ticker-log-handshake-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-log-handshake-worker-${process.pid}-${Date.now()}.mjs`
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
    return;
  }
  if (msg.type !== "log") return;
  writeSync(workerData.fd, msg.text);
  Atomics.add(new Int32Array(workerData.handshakeBuffer), 2, 1);
  throw new Error("crash after accepted log");
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
      ticker.setLines(["load"]);

      await waitForFileContent(path, (next) => next.includes("worker-ready"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      ticker.writeLog("accepted-log\n");
      let rendered = await waitForFileContent(
        path,
        (next) => (next.match(/accepted-log/g) ?? []).length >= 1
      );

      ticker.dispose();
      rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("accepted-log");
      expect(rendered.match(/accepted-log/g)).toHaveLength(1);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });
});
