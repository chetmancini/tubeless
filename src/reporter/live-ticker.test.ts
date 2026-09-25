import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SPINNER_TOKEN } from "./live-ticker-frame.js";
import { createLiveTicker } from "./live-ticker.js";

describe("createLiveTicker inline resize", () => {
  it.each(["redraw", "log"])("clears reflowed rows before %s", (action) => {
    let columns = 140;
    const chunks: string[] = [];
    const ticker = createLiveTicker({
      getColumns: () => columns,
      refreshIntervalMs: 10_000,
      unicode: false,
      write: (chunk) => chunks.push(chunk),
    });
    try {
      ticker.setLines(["running"], ["latest log"]);
      chunks.length = 0;
      columns = 80;
      if (action === "redraw") ticker.setLines(["narrow progress"]);
      else ticker.writeLog("narrow log\n");
      expect(chunks[0]).toBe("\u001B[6F\u001B[J");
      expect(chunks[1]).toBe(action === "redraw" ? "narrow progress\n" : "narrow log\n");
    } finally {
      ticker.dispose();
    }
  });
});

function dataWorker(source: string): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

function workerTicker(
  source?: string,
  write?: (chunk: string) => void,
  columns?: number | (() => number)
): {
  chunks: string[];
  close(): void;
  closeOutput(): void;
  path: string;
  ticker: ReturnType<typeof createLiveTicker>;
} {
  const path = join(tmpdir(), `tubeless-ticker-fallback-${process.pid}-${Date.now()}.log`);
  const fd = openSync(path, "w");
  const chunks: string[] = [];
  let outputOpen = true;
  const closeOutput = (): void => {
    if (!outputOpen) return;
    outputOpen = false;
    closeSync(fd);
  };
  return {
    chunks,
    close: () => {
      closeOutput();
      unlinkSync(path);
    },
    closeOutput,
    path,
    ticker: createLiveTicker({
      ...(typeof columns === "function" ? { getColumns: columns } : { columns }),
      fd,
      refreshIntervalMs: 40,
      unicode: false,
      write: write ?? ((chunk) => chunks.push(chunk)),
      ...(source === undefined ? {} : { workerUrl: dataWorker(source) }),
    }),
  };
}

describe("createLiveTicker worker fallback", () => {
  it.each([false, true])("clears reflowed rows on shutdown timeout (pending log: %s)", (log) => {
    let columns = 140;
    const workerUrl = new URL("../../dist/reporter/live-ticker-worker.js", import.meta.url);
    const { chunks, close, path, ticker } = workerTicker(
      `
      import { parentPort } from "node:worker_threads";
      await import(${JSON.stringify(workerUrl.href)});
      parentPort.on("message", () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `,
      undefined,
      () => columns
    );
    try {
      ticker.setLines(["running"], ["latest log"]);
      // Keep the main event loop blocked so fallback must drain queued snapshots.
      const waiting = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 2_000;
      while (!readFileSync(path, "utf8").includes("+- Logs ") && Date.now() < deadline) {
        Atomics.wait(waiting, 0, 0, 10);
      }
      expect(readFileSync(path, "utf8")).toContain("+- Logs ");
      columns = 80;
      if (log) ticker.writeLog("pending log\n");
      ticker.setLines(["final status"]);
      ticker.dispose();

      expect(chunks[0]).toBe("\u001B[6F\u001B[J");
      expect(chunks).toContain("final status\n");
      if (log) expect(chunks[1]).toBe("pending log\n");
      expect(chunks.at(-1)).toBe("\u001B[?25h");
    } finally {
      ticker.dispose();
      close();
    }
  });

  it.each(["redraw", "log", "stop"])("clears reflowed worker rows before %s", async (action) => {
    let columns = 140;
    const { close, path, ticker } = workerTicker(undefined, undefined, () => columns);
    try {
      ticker.setLines(["running"], ["latest log"]);
      await vi.waitFor(() => expect(readFileSync(path, "utf8")).toContain("+- Logs "));
      columns = 80;
      if (action === "redraw") ticker.setLines(["narrow progress"]);
      else if (action === "log") ticker.writeLog("narrow log\n");
      ticker.dispose();
      const output = readFileSync(path, "utf8");
      expect(output).toContain("\u001B[6F\u001B[J");
      if (action === "log") expect(output).toContain("\u001B[6F\u001B[Jnarrow log\n");
    } finally {
      ticker.dispose();
      close();
    }
  });

  it("renders the log pane through the worker and its fallback", async () => {
    for (const source of [undefined, 'throw new Error("boot failure")']) {
      const { chunks, close, path, ticker } = workerTicker(source, undefined, 120);
      try {
        ticker.setLines([`${SPINNER_TOKEN} running`], ["latest log"]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        ticker.dispose();
        const output = readFileSync(path, "utf8") + chunks.join("");
        expect(output).toContain("+- Logs ");
        expect(output).toContain("| latest log");
      } finally {
        ticker.dispose();
        close();
      }
    }
  });

  it("keeps logs and frames after an asynchronous worker failure", async () => {
    const { chunks, close, ticker } = workerTicker('throw new Error("boot failure")');
    try {
      ticker.setLines(["running"]);
      ticker.writeLog("before failure\n");
      await vi.waitFor(() => expect(chunks.join("")).toContain("before failure"));

      ticker.writeLog("after failure\n");
      ticker.setLines(["final status"]);
      ticker.dispose();

      expect(chunks.join("")).toContain("after failure");
      expect(chunks.join("")).toContain("final status");
    } finally {
      ticker.dispose();
      close();
    }
  });

  it("replays only unacknowledged logs after a worker fails between writes", async () => {
    const workerUrl = new URL("../../dist/reporter/live-ticker-worker.js", import.meta.url);
    const { chunks, close, path, ticker } = workerTicker(`
      import { parentPort } from "node:worker_threads";
      await import(${JSON.stringify(workerUrl.href)});
      parentPort.on("message", (message) => {
        if (message.type === "log") throw new Error("failed after accepting one log");
      });
    `);
    try {
      ticker.setLines(["running"]);
      ticker.writeLog("accepted log\n");
      ticker.writeLog("pending log\n");
      await vi.waitFor(() => expect(chunks.join("")).toContain("pending log"));
      ticker.dispose();
      const output = readFileSync(path, "utf8") + chunks.join("");
      expect(output.match(/accepted log/g)).toHaveLength(1);
      expect(output.match(/pending log/g)).toHaveLength(1);
    } finally {
      ticker.dispose();
      close();
    }
  });

  it("paints the retained final frame when worker shutdown times out", () => {
    const { chunks, close, ticker } = workerTicker("setInterval(() => {}, 1000)");
    try {
      ticker.setLines(["final status"]);
      ticker.dispose();

      expect(chunks.join("")).toContain("final status");
      expect(chunks.join("")).toContain("\u001B[?25h");
    } finally {
      ticker.dispose();
      close();
    }
  });

  it("bounds fallback takeover when the worker keeps output ownership", async () => {
    const protocolUrl = new URL("../../dist/reporter/live-ticker-protocol.js", import.meta.url);
    const { chunks, close, path, ticker } = workerTicker(`
      import { writeSync } from "node:fs";
      import { workerData } from "node:worker_threads";
      const { TickerWorkerState } = await import(${JSON.stringify(protocolUrl.href)});
      const state = new TickerWorkerState(workerData.stateBuffer);
      state.withWorkerOutput(() => {
        writeSync(workerData.fd, "locked\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `);
    try {
      await vi.waitFor(() => expect(readFileSync(path, "utf8")).toContain("locked"));
      ticker.setLines(["final status"]);
      const startedAt = Date.now();
      ticker.dispose();

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(chunks.join("")).not.toContain("final status");
      expect(chunks.join("")).toContain("\u001B[?25h");
    } finally {
      ticker.dispose();
      close();
    }
  });

  it("does not retry fallback when writing its retained frame fails", () => {
    const write = vi.fn(() => {
      throw new Error("output closed");
    });
    const { close, ticker } = workerTicker("setInterval(() => {}, 1000)", write);
    try {
      ticker.setLines(["final status"]);

      expect(() => ticker.dispose()).toThrow("output closed");
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      ticker.dispose();
      close();
    }
  });

  it("falls back when the worker cannot render its final frame", async () => {
    const { chunks, close, closeOutput, path, ticker } = workerTicker();
    try {
      ticker.setLines(["final status"]);
      await vi.waitFor(() => expect(readFileSync(path, "utf8")).toContain("final status"));
      closeOutput();

      ticker.dispose();

      expect(chunks.join("")).toContain("final status");
    } finally {
      ticker.dispose();
      close();
    }
  });
});
