import { closeSync, openSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

function dataWorker(source: string): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

function workerTicker(source: string): {
  chunks: string[];
  close(): void;
  ticker: ReturnType<typeof createLiveTicker>;
} {
  const path = join(tmpdir(), `tubeless-ticker-fallback-${process.pid}-${Date.now()}.log`);
  const fd = openSync(path, "w");
  const chunks: string[] = [];
  return {
    chunks,
    close: () => {
      closeSync(fd);
      unlinkSync(path);
    },
    ticker: createLiveTicker({
      fd,
      refreshIntervalMs: 40,
      unicode: false,
      workerUrl: dataWorker(source),
      write: (chunk) => chunks.push(chunk),
    }),
  };
}

describe("createLiveTicker worker fallback", () => {
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
});
