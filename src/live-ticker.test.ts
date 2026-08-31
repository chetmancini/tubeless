import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createLiveTicker,
  elapsedToken,
  paintLiveLines,
  shimmerToken,
  SPINNER_TOKEN,
} from "./live-ticker";

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
        if (rendered.includes("load") && /[-\\|\/] /.test(rendered)) break;
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
      expect(plain).toMatch(/[-\\|\/] load/);
      expect(rendered).toContain("\u001B[0;1;36m");
      expect(rendered).toContain("logged from parent");
      expect(rendered).not.toContain("\u0004");
      expect(rendered).not.toContain("\u0005");
    } finally {
      closeSync(fd);
      unlinkSync(path);
    }
  });
});
