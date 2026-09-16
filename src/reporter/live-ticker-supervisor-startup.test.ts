import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createLiveTicker, shimmerToken, SPINNER_TOKEN, type LiveTicker } from "./live-ticker.js";
import { waitForFileContent } from "./live-ticker.test-support.js";

describe("live ticker supervisor: startup and fallback", () => {
  it("loads a compiled worker file instead of eval source", () => {
    const compiled = fileURLToPath(
      new URL("../../dist/reporter/live-ticker-worker.js", import.meta.url)
    );
    const supervisor = fileURLToPath(
      new URL("../../dist/reporter/live-ticker-supervisor.js", import.meta.url)
    );
    const source = readFileSync(new URL("./live-ticker.ts", import.meta.url), "utf8");

    const supervisorSource = readFileSync(
      new URL("./live-ticker-supervisor.ts", import.meta.url),
      "utf8"
    );
    expect(existsSync(compiled)).toBe(true);
    expect(existsSync(supervisor)).toBe(true);
    expect(source).not.toContain("WORKER_SOURCE");
    expect(source).not.toContain("eval: true");
    expect(source).not.toContain("ISOLATE_DRAIN_MS");
    expect(supervisorSource).not.toContain("setInterval");
    expect(supervisorSource).toContain("terminated");
    expect(source).toContain("terminated");
  });

  it("paints, logs, and stops through the compiled worker", async () => {
    const path = join(tmpdir(), `tubeless-ticker-${process.pid}-${Date.now()}.log`);
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
        write: (chunk) => {
          inlineWrites.push(chunk);
        },
      });
      ticker.setLines([`${SPINNER_TOKEN} ${shimmerToken("load")}`]);

      let rendered = await waitForFileContent(
        path,
        (next) => next.includes("load") && /[-\\|/] /.test(next) && next.includes("\u001B[0;1;36m"),
        1_000
      );

      ticker.writeLog("logged from parent\n");
      rendered = await waitForFileContent(path, (next) => next.includes("logged from parent"), 500);

      const disposeStarted = Date.now();
      ticker.dispose();
      expect(Date.now() - disposeStarted).toBeLessThan(120);
      rendered = readFileSync(path, "utf8");
      const plain = rendered.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");

      expect(inlineWrites).toEqual([]);
      expect(rendered).toContain("\u001B[?25l");
      expect(rendered).toContain("\u001B[?25h");
      expect(plain).toMatch(/[-\\|/] load/);
      expect(rendered).toContain("\u001B[0;1;36m");
      expect(rendered).toContain("logged from parent");
      expect(rendered).not.toContain("\u0004");
      expect(rendered).not.toContain("\u0005");
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
    }
  });

  it("starts the file worker when the parent inherited --input-type", () => {
    const path = join(tmpdir(), `tubeless-input-type-${process.pid}-${Date.now()}.log`);
    const tickerUrl = pathToFileURL(
      fileURLToPath(new URL("../../dist/reporter/live-ticker.js", import.meta.url))
    ).href;
    const child = spawnSync("node", ["--input-type=commonjs"], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      input: `
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
const { closeSync, openSync, readFileSync, unlinkSync } = require("node:fs");
(async () => {
  const { createLiveTicker, SPINNER_TOKEN, shimmerToken } = await import(${JSON.stringify(tickerUrl)});
  const fd = openSync(${JSON.stringify(path)}, "w");
  const inlineWrites = [];
  try {
    const ticker = createLiveTicker({
      color: true,
      columns: 80,
      fd,
      refreshIntervalMs: 20,
      unicode: false,
      write: (chunk) => inlineWrites.push(chunk),
    });
    ticker.setLines([\`\${SPINNER_TOKEN} \${shimmerToken("load")}\`]);
    // Node 22 can take more than one second to start a file worker on a loaded CI host.
    const deadline = Date.now() + 2000;
    let rendered = "";
    for (;;) {
      rendered = readFileSync(${JSON.stringify(path)}, "utf8");
      if (rendered.includes("load") || Date.now() >= deadline) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    ticker.dispose();
    rendered = readFileSync(${JSON.stringify(path)}, "utf8");
    if (inlineWrites.length !== 0) {
      throw new Error("fell back to the inline ticker");
    }
    if (!rendered.includes("load")) {
      throw new Error("worker did not paint");
    }
    process.stdout.write(rendered);
  } finally {
    closeSync(fd);
    unlinkSync(${JSON.stringify(path)});
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
      timeout: 5_000,
    });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).not.toContain("ERR_INPUT_TYPE_NOT_ALLOWED");
    const plain = child.stdout.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
    expect(plain).toMatch(/[-\\|/] load/);
  });

  it("falls back to the inline ticker when the worker fails to boot", async () => {
    const path = join(tmpdir(), `tubeless-ticker-boot-fail-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-boot-fail-worker-${process.pid}-${Date.now()}.js`
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
      ticker.setLines([`${SPINNER_TOKEN} ${shimmerToken("load")}`]);

      const rendered = await waitForFileContent(
        path,
        (next) => next.includes("load") && /[-\\|/] /.test(next)
      );

      ticker.dispose();
      const plain = rendered.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
      expect(plain).toMatch(/[-\\|/] load/);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("does not fall back to the inline ticker after a healthy dispose", async () => {
    const path = join(tmpdir(), `tubeless-ticker-dispose-${process.pid}-${Date.now()}.log`);
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
        write: (chunk) => {
          inlineWrites.push(chunk);
        },
      });
      ticker.setLines([`${SPINNER_TOKEN} load`]);

      let rendered = await waitForFileContent(path, (next) => next.includes("load"), 1_000);
      expect(rendered).toContain("load");

      ticker.dispose();
      ticker.writeLog("post-dispose\n");
      rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("post-dispose");
      expect(inlineWrites).toEqual([]);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
    }
  });

  it("does not paint inline fallback when a requested terminate exits non-zero", async () => {
    const path = join(tmpdir(), `tubeless-ticker-term-exit-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-term-exit-worker-${process.pid}-${Date.now()}.mjs`
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
  if (msg.type !== "stop") return;
  writeSync(workerData.fd, "worker-owned-final\\n");
  Atomics.store(new Int32Array(workerData.handshakeBuffer), 0, 1);
  Atomics.notify(new Int32Array(workerData.handshakeBuffer), 0);
  throw new Error("non-zero exit after stop handshake");
});
`
    );
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
        workerUrl: pathToFileURL(workerPath),
        write: (chunk) => {
          inlineWrites.push(chunk);
          writeSync(fd, chunk);
        },
      });
      ticker.setLines(["inline-fallback-frame"]);

      await waitForFileContent(path, (next) => next.includes("worker-ready"));
      expect(readFileSync(path, "utf8"), readFileSync(workerPath, "utf8")).toContain(
        "worker-ready"
      );

      ticker.dispose();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("worker-owned-final");
      expect(inlineWrites).toEqual([]);
      expect(rendered).not.toContain("inline-fallback-frame");
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("clears a painted worker frame before falling back inline", async () => {
    const path = join(tmpdir(), `tubeless-ticker-stale-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-stale-worker-${process.pid}-${Date.now()}.mjs`
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

      let rendered = await waitForFileContent(
        path,
        (next) => next.includes("worker-stale-2") && next.includes("\u001B[2F\u001B[J")
      );

      ticker.dispose();
      expect(rendered).toContain("worker-stale-1");
      expect(rendered).toMatch(/worker-stale-2\n\u001B\[2F\u001B\[J/);
      const afterClear = rendered.slice(rendered.indexOf("\u001B[2F\u001B[J"));
      const plain = afterClear.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
      expect(plain).toMatch(/[-\\|/] load/);
    } finally {
      ticker?.dispose();
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("does not crash when dispose races a boot-failing worker", () => {
    const path = join(tmpdir(), `tubeless-ticker-dispose-race-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-dispose-race-worker-${process.pid}-${Date.now()}.js`
    );
    const scriptPath = join(
      tmpdir(),
      `tubeless-ticker-dispose-race-script-${process.pid}-${Date.now()}.mjs`
    );
    writeFileSync(workerPath, 'throw new Error("boot failure");\n');
    const tickerUrl = pathToFileURL(
      fileURLToPath(new URL("../../dist/reporter/live-ticker.js", import.meta.url))
    ).href;
    writeFileSync(
      scriptPath,
      `
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(2);
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(3);
});
const { closeSync, openSync, unlinkSync } = await import("node:fs");
const { createLiveTicker, SPINNER_TOKEN } = await import(${JSON.stringify(tickerUrl)});
const fd = openSync(${JSON.stringify(path)}, "w");
try {
  const ticker = createLiveTicker({
    color: true,
    columns: 80,
    fd,
    refreshIntervalMs: 20,
    unicode: false,
    workerUrl: new URL(${JSON.stringify(pathToFileURL(workerPath).href)}),
    write: () => {},
  });
  ticker.setLines([\`\${SPINNER_TOKEN} load\`]);
  ticker.dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
} finally {
  closeSync(fd);
  unlinkSync(${JSON.stringify(path)});
}
`
    );
    try {
      const child = spawnSync("node", [scriptPath], {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "" },
        timeout: 5_000,
      });
      expect(child.status, child.stderr + child.stdout).toBe(0);
    } finally {
      unlinkSync(workerPath);
      unlinkSync(scriptPath);
    }
  });
});
