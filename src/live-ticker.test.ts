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
import {
  createLiveTicker,
  elapsedToken,
  paintLiveLines,
  shimmerToken,
  SPINNER_TOKEN,
} from "./live-ticker.js";

const RESET = "\u001B[0m";
const SHIMMER_BRIGHT = "\u001B[0;1;36m";
const SHIMMER_DIM = "\u001B[0;2;36m";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

describe("paintLiveLines", () => {
  it("sweeps a 3-column bright band across shimmer text", () => {
    const line = `${SPINNER_TOKEN} ${shimmerToken("load")}`;
    const at0 = paintLiveLines([line], "-", 0, undefined, true)[0];
    const at80 = paintLiveLines([line], "-", 80, undefined, true)[0];
    const at160 = paintLiveLines([line], "-", 160, undefined, true)[0];

    expect(at0).toBe(`- ${RESET}${SHIMMER_BRIGHT}l${SHIMMER_DIM}oad${RESET}`);
    expect(at80).toBe(`- ${RESET}${SHIMMER_BRIGHT}lo${SHIMMER_DIM}ad${RESET}`);
    expect(at160).toBe(`- ${RESET}${SHIMMER_BRIGHT}loa${SHIMMER_DIM}d${RESET}`);
  });

  it("emits a reset before the first shimmer character so prior styling cannot bleed", () => {
    const line = `\u001B[1;36m${SPINNER_TOKEN} ${shimmerToken("load")}`;
    const painted = paintLiveLines([line], "-", 0, undefined, true)[0];

    expect(painted).toBe(`\u001B[1;36m- ${RESET}${SHIMMER_BRIGHT}l${SHIMMER_DIM}oad${RESET}`);
  });

  it("unwraps shimmer tokens without ANSI when color is off", () => {
    const line = `${SPINNER_TOKEN} ${shimmerToken("load")} ${elapsedToken(0)}`;
    const painted = paintLiveLines([line], "-", 25)[0];

    expect(painted).toBe("- load 25ms");
    expect(painted).not.toContain("\u0004");
    expect(painted).not.toContain("\u0005");
    expect(painted).not.toContain("\u001B[");
  });

  it("does not leak shimmer tokens when color is on", () => {
    const painted = paintLiveLines([shimmerToken("fan-out")], "-", 0, undefined, true)[0];

    expect(stripAnsi(painted ?? "")).toBe("fan-out");
    expect(painted).not.toContain("\u0004");
    expect(painted).not.toContain("\u0005");
  });

  it("counts the bright band in columns, not code points", () => {
    // Ａ is 2 columns. At 160ms the 3-column band covers Ａ+B (3 columns), not 3 code points.
    const painted = paintLiveLines([shimmerToken("ＡBC")], "-", 160, undefined, true)[0];

    expect(painted).toBe(`${RESET}${SHIMMER_BRIGHT}ＡB${SHIMMER_DIM}C${RESET}`);
  });

  it("resets ANSI when a shimmered row is truncated", () => {
    const painted = paintLiveLines([shimmerToken("x".repeat(40))], "-", 0, 10, true)[0];

    expect(painted?.endsWith("\u001B[0m…")).toBe(true);
    expect(painted).not.toContain("\u0004");
    expect(stripAnsi(painted ?? "").endsWith("…")).toBe(true);
  });
});

describe("live ticker worker", () => {
  it("loads a compiled worker file instead of eval source", () => {
    const compiled = fileURLToPath(new URL("../dist/live-ticker-worker.js", import.meta.url));
    const source = readFileSync(new URL("./live-ticker.ts", import.meta.url), "utf8");

    expect(existsSync(compiled)).toBe(true);
    expect(source).not.toContain("WORKER_SOURCE");
    expect(source).not.toContain("eval: true");
  });

  it("paints, logs, and stops through the compiled worker", () => {
    const path = join(tmpdir(), `tubeless-ticker-${process.pid}-${Date.now()}.log`);
    const fd = openSync(path, "w");
    const inlineWrites: string[] = [];
    try {
      const ticker = createLiveTicker({
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

      const paintedDeadline = Date.now() + 1_000;
      let rendered = "";
      while (Date.now() < paintedDeadline) {
        rendered = readFileSync(path, "utf8");
        if (
          rendered.includes("load") &&
          /[-\\|/] /.test(rendered) &&
          rendered.includes("\u001B[0;1;36m")
        ) {
          break;
        }
      }

      ticker.writeLog("logged from parent\n");
      const loggedDeadline = Date.now() + 500;
      while (Date.now() < loggedDeadline) {
        rendered = readFileSync(path, "utf8");
        if (rendered.includes("logged from parent")) break;
      }

      const disposeStarted = Date.now();
      ticker.dispose();
      expect(Date.now() - disposeStarted).toBeLessThan(200);
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
      closeSync(fd);
      unlinkSync(path);
    }
  });

  it("starts the file worker when the parent inherited --input-type", () => {
    const path = join(tmpdir(), `tubeless-input-type-${process.pid}-${Date.now()}.log`);
    const tickerUrl = pathToFileURL(
      fileURLToPath(new URL("../dist/live-ticker.js", import.meta.url))
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
    const deadline = Date.now() + 1000;
    let rendered = "";
    while (Date.now() < deadline) {
      rendered = readFileSync(${JSON.stringify(path)}, "utf8");
      if (rendered.includes("load")) break;
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
      ticker.setLines([`${SPINNER_TOKEN} ${shimmerToken("load")}`]);

      const paintedDeadline = Date.now() + 2_000;
      let rendered = "";
      while (Date.now() < paintedDeadline) {
        rendered = readFileSync(path, "utf8");
        if (rendered.includes("load") && /[-\\|\/] /.test(rendered)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      const plain = rendered.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
      expect(plain).toMatch(/[-\\|\/] load/);
    } finally {
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("does not fall back to the inline ticker after a healthy dispose", () => {
    const path = join(tmpdir(), `tubeless-ticker-dispose-${process.pid}-${Date.now()}.log`);
    const fd = openSync(path, "w");
    const inlineWrites: string[] = [];
    try {
      const ticker = createLiveTicker({
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

      const paintedDeadline = Date.now() + 1_000;
      let rendered = "";
      while (Date.now() < paintedDeadline) {
        rendered = readFileSync(path, "utf8");
        if (rendered.includes("load")) break;
      }
      expect(rendered).toContain("load");

      ticker.dispose();
      ticker.writeLog("post-dispose\n");
      rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("post-dispose");
      expect(inlineWrites).toEqual([]);
    } finally {
      closeSync(fd);
      unlinkSync(path);
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
      ticker.setLines([`${SPINNER_TOKEN} load`, `${SPINNER_TOKEN} more`]);

      const paintedDeadline = Date.now() + 2_000;
      let rendered = "";
      while (Date.now() < paintedDeadline) {
        rendered = readFileSync(path, "utf8");
        if (rendered.includes("worker-stale-2") && rendered.includes("\u001B[2F\u001B[J")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      expect(rendered).toContain("worker-stale-1");
      expect(rendered).toMatch(/worker-stale-2\n\u001B\[2F\u001B\[J/);
      const afterClear = rendered.slice(rendered.indexOf("\u001B[2F\u001B[J"));
      const plain = afterClear.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
      expect(plain).toMatch(/[-\\|\/] load/);
    } finally {
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
      fileURLToPath(new URL("../dist/live-ticker.js", import.meta.url))
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

  it("replays logs sent before the worker fails to boot", async () => {
    const path = join(tmpdir(), `tubeless-ticker-log-replay-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-log-replay-worker-${process.pid}-${Date.now()}.js`
    );
    writeFileSync(workerPath, 'throw new Error("boot failure");\n');
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
      ticker.setLines([`${SPINNER_TOKEN} load`]);
      ticker.writeLog("pre-fallback log\n");

      const paintedDeadline = Date.now() + 2_000;
      let rendered = "";
      while (Date.now() < paintedDeadline) {
        rendered = readFileSync(path, "utf8");
        if (rendered.includes("pre-fallback log")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      expect(rendered).toContain("pre-fallback log");
    } finally {
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
      ticker.setLines([`${SPINNER_TOKEN} load`]);

      const liveDeadline = Date.now() + 2_000;
      while (Date.now() < liveDeadline) {
        if (readFileSync(path, "utf8").includes("worker-live")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      ticker.writeLog("session-log\n");
      const loggedDeadline = Date.now() + 2_000;
      while (Date.now() < loggedDeadline) {
        if (readFileSync(path, "utf8").includes("session-log")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.writeLog("crash-log\n");
      const fallbackDeadline = Date.now() + 2_000;
      let rendered = "";
      while (Date.now() < fallbackDeadline) {
        rendered = readFileSync(path, "utf8");
        const plain = rendered.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
        if (rendered.includes("crash-log") && /[-\\|\/] load/.test(plain)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      rendered = readFileSync(path, "utf8");
      expect(rendered.match(/session-log/g)).toHaveLength(1);
    } finally {
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
      ticker.setLines([`${SPINNER_TOKEN} load`, `${SPINNER_TOKEN} more`]);

      const paintedDeadline = Date.now() + 2_000;
      let rendered = "";
      while (Date.now() < paintedDeadline) {
        rendered = readFileSync(path, "utf8");
        if (rendered.includes("load") && /[-\\|\/] /.test(rendered)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      expect(rendered).not.toMatch(/\u001B\[\d+F/);
      const plain = rendered.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
      expect(plain).toMatch(/[-\\|\/] load/);
    } finally {
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
      ticker.writeLog("step done\n");
      ticker.setLines(["final status"]);

      const paintedDeadline = Date.now() + 2_000;
      let rendered = "";
      while (Date.now() < paintedDeadline) {
        rendered = readFileSync(path, "utf8");
        if (rendered.includes("step done") && rendered.includes("final status")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("step done");
      expect(rendered).toContain("final status");
      expect(rendered.lastIndexOf("final status")).toBeGreaterThan(
        rendered.lastIndexOf("step done")
      );
    } finally {
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
      ticker.setLines(["load"]);

      const liveDeadline = Date.now() + 2_000;
      while (Date.now() < liveDeadline) {
        if (readFileSync(path, "utf8").includes("worker-ready")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      ticker.writeLog("lost-log\n");
      const fallbackDeadline = Date.now() + 2_000;
      let rendered = "";
      while (Date.now() < fallbackDeadline) {
        rendered = readFileSync(path, "utf8");
        if (rendered.includes("lost-log")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("lost-log");
      expect(rendered.match(/lost-log/g)).toHaveLength(1);
    } finally {
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
      ticker.setLines(["load"]);

      const liveDeadline = Date.now() + 2_000;
      while (Date.now() < liveDeadline) {
        if (readFileSync(path, "utf8").includes("worker-ready")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      ticker.writeLog("accepted-log\n");
      const fallbackDeadline = Date.now() + 2_000;
      let rendered = "";
      while (Date.now() < fallbackDeadline) {
        rendered = readFileSync(path, "utf8");
        if ((rendered.match(/accepted-log/g) ?? []).length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("accepted-log");
      expect(rendered.match(/accepted-log/g)).toHaveLength(1);
    } finally {
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });

  it("does not interleave delayed worker output after a timed-out dispose", async () => {
    const path = join(tmpdir(), `tubeless-ticker-stop-timeout-${process.pid}-${Date.now()}.log`);
    const workerPath = join(
      tmpdir(),
      `tubeless-ticker-stop-timeout-worker-${process.pid}-${Date.now()}.mjs`
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
  const start = Date.now();
  while (Date.now() - start < 800) {}
  writeSync(workerData.fd, "late-worker-output\\n");
  Atomics.store(new Int32Array(workerData.handshakeBuffer), 0, 1);
  Atomics.notify(new Int32Array(workerData.handshakeBuffer), 0);
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
      ticker.setLines(["final-status"]);

      const liveDeadline = Date.now() + 2_000;
      while (Date.now() < liveDeadline) {
        if (readFileSync(path, "utf8").includes("worker-ready")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      ticker.dispose();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const rendered = readFileSync(path, "utf8");
      expect(rendered).toContain("final-status");
      expect(rendered).not.toContain("late-worker-output");
    } finally {
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
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
      ticker.setLines(["final-status"]);

      const liveDeadline = Date.now() + 2_000;
      while (Date.now() < liveDeadline) {
        if (readFileSync(path, "utf8").includes("worker-ready")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const started = Date.now();
      ticker.dispose();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(1_200);
      expect(readFileSync(path, "utf8")).toContain("final-status");
    } finally {
      closeSync(fd);
      unlinkSync(path);
      unlinkSync(workerPath);
    }
  });
});
