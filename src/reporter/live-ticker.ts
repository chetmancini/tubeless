import { Worker } from "node:worker_threads";
import { formatDurationMs } from "./reporter.js";

export const SPINNER_TOKEN = "\u0001";
const ELAPSED_TOKEN_START = "\u0002";
const ELAPSED_TOKEN_END = "\u0003";
export const SHIMMER_TOKEN_START = "\u0004";
const SHIMMER_TOKEN_END = "\u0005";

const ANSI = {
  clearDown: "\u001B[J",
  hideCursor: "\u001B[?25l",
  reset: "\u001B[0m",
  showCursor: "\u001B[?25h",
} as const;

const SHIMMER_BAND_COLUMNS = 3;
const SHIMMER_BRIGHT = "\u001B[0;1;36m";
const SHIMMER_DIM = "\u001B[0;2;36m";
const SHIMMER_FRAME_MS = 80;

const ANSI_STYLE = /\u001B\[[0-9;]*m/g;
const ANSI_STYLE_PREFIX = /^\u001B\[[0-9;]*m/;
const COMBINING_MARK = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}/u;

const SPINNERS = {
  ascii: ["-", "\\", "|", "/"],
  unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

function characterWidth(character: string): number {
  if (COMBINING_MARK.test(character) || character === "\u200D") return 0;
  if (EMOJI.test(character)) return 2;
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
    ? 2
    : 1;
}

function visibleWidth(value: string): number {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}

function fitLine(value: string, columns: number | undefined): string {
  if (!columns || columns <= 1) return value;
  const maxWidth = columns - 1;
  const plain = value.replace(ANSI_STYLE, "");
  if (visibleWidth(plain) <= maxWidth) return value;
  const targetWidth = Math.max(0, maxWidth - 1);
  let width = 0;
  let truncated = "";
  let index = 0;
  let hasStyle = false;
  while (index < value.length) {
    const style = value.slice(index).match(ANSI_STYLE_PREFIX)?.[0];
    if (style) {
      truncated += style;
      index += style.length;
      hasStyle = true;
      continue;
    }
    const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
    const nextWidth = width + characterWidth(character);
    if (nextWidth > targetWidth) break;
    truncated += character;
    width = nextWidth;
    index += character.length;
  }
  return `${truncated}${hasStyle ? ANSI.reset : ""}…`;
}

export function elapsedToken(startedAtMs: number): string {
  return `${ELAPSED_TOKEN_START}${startedAtMs}${ELAPSED_TOKEN_END}`;
}

export function shimmerToken(value: string): string {
  return `${SHIMMER_TOKEN_START}${value}${SHIMMER_TOKEN_END}`;
}

function paintShimmerText(text: string, nowMs: number): string {
  const characters = [...text];
  if (characters.length === 0) return text;
  const widths = characters.map(characterWidth);
  const totalWidth = visibleWidth(text);
  const period = Math.max(1, totalWidth + SHIMMER_BAND_COLUMNS);
  const head = Math.floor(nowMs / SHIMMER_FRAME_MS) % period;
  const bandStart = head - SHIMMER_BAND_COLUMNS + 1;
  let column = 0;
  let output = ANSI.reset;
  let last: "bright" | "dim" | undefined;
  for (const [index, character] of characters.entries()) {
    const width = widths[index] ?? 0;
    const inBand =
      width === 0 ? last === "bright" : column <= head && column + width - 1 >= bandStart;
    const style = inBand ? "bright" : "dim";
    if (style !== last) {
      output += style === "bright" ? SHIMMER_BRIGHT : SHIMMER_DIM;
      last = style;
    }
    output += character;
    column += width;
  }
  return `${output}${ANSI.reset}`;
}

function replaceLiveTokens(line: string, spinner: string, nowMs: number, color: boolean): string {
  return line
    .replaceAll(SPINNER_TOKEN, spinner)
    .replace(
      new RegExp(`${ELAPSED_TOKEN_START}(\\d+)${ELAPSED_TOKEN_END}`, "g"),
      (_match, start: string) => formatDurationMs(Math.max(0, nowMs - Number(start)))
    )
    .replace(
      new RegExp(`${SHIMMER_TOKEN_START}(.*?)${SHIMMER_TOKEN_END}`, "g"),
      (_match, text: string) => (color ? paintShimmerText(text, nowMs) : text)
    );
}

export function paintLiveLines(
  lines: readonly string[],
  spinner: string,
  nowMs: number,
  columns?: number,
  color = false
): string[] {
  return lines.map((line) => fitLine(replaceLiveTokens(line, spinner, nowMs, color), columns));
}

export interface LiveTicker {
  setLines(lines: readonly string[]): void;
  writeLog(text: string): void;
  dispose(): void;
}

export interface LiveTickerOptions {
  columns?: number;
  getColumns?(): number | undefined;
  fd?: number;
  refreshIntervalMs: number;
  unicode: boolean;
  color?: boolean;
  write(chunk: string): void;
}

type TickerWorkerMessage =
  | { columns?: number; lines: string[]; type: "lines" }
  | { text: string; type: "log" }
  | { columns?: number; lines: string[]; type: "stop" };

export class TickerFrame {
  private cursorHidden = false;
  private frameLineCount = 0;

  constructor(private readonly write: (chunk: string) => void) {}

  showCursor(): void {
    if (!this.cursorHidden) return;
    this.write(ANSI.showCursor);
    this.cursorHidden = false;
  }

  clear(): void {
    if (this.frameLineCount === 0) return;
    this.write(`\u001B[${this.frameLineCount}F${ANSI.clearDown}`);
    this.frameLineCount = 0;
  }

  redraw(lines: readonly string[]): void {
    if (!this.cursorHidden) {
      this.write(ANSI.hideCursor);
      this.cursorHidden = true;
    }
    this.clear();
    if (lines.length === 0) return;
    this.write(`${lines.join("\n")}\n`);
    this.frameLineCount = lines.length;
  }
}

function resolveColumns(options: LiveTickerOptions): number | undefined {
  return options.getColumns?.() ?? options.columns;
}

export function currentSpinner(unicode: boolean, refreshIntervalMs: number): string {
  const frames = unicode ? SPINNERS.unicode : SPINNERS.ascii;
  return frames[Math.floor(Date.now() / refreshIntervalMs) % frames.length] ?? frames[0]!;
}

function createInlineTicker(options: LiveTickerOptions): LiveTicker {
  let disposed = false;
  let lines: readonly string[] = [];
  const frame = new TickerFrame((chunk) => options.write(chunk));
  const redraw = (): void => {
    if (disposed) return;
    frame.redraw(
      paintLiveLines(
        lines,
        currentSpinner(options.unicode, options.refreshIntervalMs),
        Date.now(),
        resolveColumns(options),
        options.color === true
      )
    );
  };

  const timer = setInterval(() => {
    if (
      disposed ||
      !lines.some((line) => line.includes(SPINNER_TOKEN) || line.includes(SHIMMER_TOKEN_START))
    ) {
      return;
    }
    redraw();
  }, options.refreshIntervalMs);
  timer.unref();

  return {
    setLines(nextLines) {
      lines = nextLines;
      redraw();
    },
    writeLog(text) {
      if (disposed) {
        options.write(text);
        return;
      }
      frame.clear();
      options.write(text);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      frame.showCursor();
    },
  };
}

function resolveLiveTickerWorkerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../../dist/reporter/live-ticker-worker.js", import.meta.url)
    : new URL("./live-ticker-worker.js", import.meta.url);
}

function fileWorkerExecArgv(argv: readonly string[] = process.execArgv): string[] {
  const next: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-type") {
      index += 1;
    } else if (!arg.startsWith("--input-type=")) {
      next.push(arg);
    }
  }
  return next;
}

function createWorkerTicker(options: LiveTickerOptions & { fd: number }): LiveTicker {
  const stopBuffer = new SharedArrayBuffer(4);
  const stopped = new Int32Array(stopBuffer);
  const worker = new Worker(resolveLiveTickerWorkerUrl(), {
    execArgv: fileWorkerExecArgv(),
    workerData: {
      color: options.color === true,
      columns: resolveColumns(options),
      fd: options.fd,
      refreshIntervalMs: options.refreshIntervalMs,
      stopBuffer,
      unicode: options.unicode,
    },
  });
  let disposed = false;
  let lines: readonly string[] = [];

  worker.on("error", () => {
    if (!disposed) options.write(ANSI.showCursor);
  });
  worker.unref();

  return {
    setLines(nextLines) {
      if (disposed) return;
      lines = nextLines;
      worker.postMessage({
        columns: resolveColumns(options),
        lines: [...nextLines],
        type: "lines",
      } satisfies TickerWorkerMessage);
    },
    writeLog(text) {
      if (disposed) {
        options.write(text);
        return;
      }
      worker.postMessage({ text, type: "log" } satisfies TickerWorkerMessage);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        worker.postMessage({
          columns: resolveColumns(options),
          lines: [...lines],
          type: "stop",
        } satisfies TickerWorkerMessage);
        if (Atomics.wait(stopped, 0, 0, 500) === "timed-out") {
          options.write(ANSI.showCursor);
        }
      } catch {
        options.write(ANSI.showCursor);
      } finally {
        void worker.terminate();
      }
    },
  };
}

function outputFd(fd: number | undefined): fd is number {
  return fd !== undefined && Number.isInteger(fd) && fd >= 0;
}

export function createLiveTicker(options: LiveTickerOptions): LiveTicker {
  if (outputFd(options.fd)) {
    try {
      return createWorkerTicker({ ...options, fd: options.fd });
    } catch {
      // Some embeddings do not provide worker threads.
    }
  }
  return createInlineTicker(options);
}
