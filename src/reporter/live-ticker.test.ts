import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLiveTicker,
  elapsedToken,
  paintLiveLines,
  shimmerToken,
  SPINNER_TOKEN,
  TickerFrame,
} from "./live-ticker.js";

const RESET = "\u001B[0m";
const SHIMMER_BRIGHT = "\u001B[0;1;36m";
const SHIMMER_DIM = "\u001B[0;2;36m";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

describe("paintLiveLines", () => {
  it("fits animated progress beside a bounded log window", () => {
    const lines = paintLiveLines(
      [`${SPINNER_TOKEN} ${shimmerToken("x".repeat(100))} ${elapsedToken(0)}`],
      "-",
      25,
      120,
      true,
      true,
      ["first line", "界".repeat(40)]
    );
    expect(lines).toHaveLength(4);
    expect(stripAnsi(lines[0]!)).toContain("╭─ Logs ");
    expect(stripAnsi(lines[1]!)).toContain("│ first line");
    expect(stripAnsi(lines[2]!)).toMatch(/… +│$/);
    for (const line of lines) {
      const width = [...stripAnsi(line)].reduce((sum, char) => sum + (char === "界" ? 2 : 1), 0);
      expect(width).toBe(119);
      expect(line).not.toMatch(/[\u0001-\u0005]/);
    }
  });

  it("omits the pane below 120 columns and uses ASCII borders when requested", () => {
    expect(paintLiveLines(["progress"], "-", 0, 119, false, true, ["log"])).toEqual(["progress"]);
    expect(paintLiveLines(["progress"], "-", 0, undefined, false, true, ["log"])).toEqual([
      "progress",
    ]);
    const ascii = paintLiveLines(["progress"], "-", 0, 120, false, false, ["log"]);
    expect(ascii.join("\n")).toContain("+- Logs ");
    expect(ascii.join("\n")).toContain("| log");
    expect(ascii.join("\n")).not.toMatch(/[^\x00-\x7F]/);
  });

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

  it("uses three dots when truncating in ASCII mode", () => {
    const painted = paintLiveLines(["abcdefghij"], "-", 0, 8, false, false)[0];

    expect(painted).toBe("abcd...");
    expect(painted).not.toContain("…");
    expect(paintLiveLines(["abc"], "-", 0, 2, false, false)[0]).toBe(".");
  });
});

describe("TickerFrame resize clearing", () => {
  it("clears all reflowed pane rows before painting a narrow frame", () => {
    const chunks: string[] = [];
    const frame = new TickerFrame((chunk) => chunks.push(chunk));
    const wide = paintLiveLines(["running"], "-", 0, 140, false, false, ["latest log"]);
    frame.redraw(wide, 140);
    chunks.length = 0;

    // Three 139-column pane rows become six physical rows at 80 columns.
    frame.redraw(["narrow progress"], 80);
    expect(chunks).toEqual(["\u001B[6F\u001B[J", "narrow progress\n"]);
    chunks.length = 0;
    frame.redraw(wide, 140);
    expect(chunks[0]).toBe("\u001B[1F\u001B[J");
  });

  it("counts ANSI, wide characters, combining marks, and exact-width lines", () => {
    const chunks: string[] = [];
    const frame = new TickerFrame((chunk) => chunks.push(chunk));
    frame.redraw(["\u001B[31m界界界界界\u001B[0m", "abcde\u0301", ""], 20);
    frame.clear(5);
    // Wide glyphs wrap before the last column; combining marks add no column.
    expect(chunks.at(-1)).toBe("\u001B[5F\u001B[J");
    const cleared = chunks.length;
    frame.clear(5);
    expect(chunks).toHaveLength(cleared);
  });
});

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
    const { chunks, close, path, ticker } = workerTicker(`
      import { writeSync } from "node:fs";
      import { workerData } from "node:worker_threads";
      const state = new Int32Array(workerData.stateBuffer);
      Atomics.store(state, 4, 1);
      writeSync(workerData.fd, "locked\\n");
      setInterval(() => {}, 1000);
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
