import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { formatDurationMs } from "./reporter.js";

export const SPINNER_TOKEN = "\u0001";
export const ELAPSED_TOKEN_START = "\u0002";
export const ELAPSED_TOKEN_END = "\u0003";
export const SHIMMER_TOKEN_START = "\u0004";
export const SHIMMER_TOKEN_END = "\u0005";

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

interface TickerState {
  cursorHidden: boolean;
  disposed: boolean;
  frameLineCount: number;
  lines: readonly string[];
}

function resolveColumns(options: LiveTickerOptions): number | undefined {
  return options.getColumns?.() ?? options.columns;
}

function currentSpinner(unicode: boolean, refreshIntervalMs: number): string {
  const frames = unicode ? SPINNERS.unicode : SPINNERS.ascii;
  return frames[Math.floor(Date.now() / refreshIntervalMs) % frames.length] ?? frames[0]!;
}

function createInlineTicker(options: LiveTickerOptions): LiveTicker {
  const state: TickerState = {
    cursorHidden: false,
    disposed: false,
    frameLineCount: 0,
    lines: [],
  };

  const write = (chunk: string): void => {
    options.write(chunk);
  };

  const hideCursor = (): void => {
    if (state.cursorHidden) return;
    write(ANSI.hideCursor);
    state.cursorHidden = true;
  };

  const showCursor = (): void => {
    if (!state.cursorHidden) return;
    write(ANSI.showCursor);
    state.cursorHidden = false;
  };

  const clearFrame = (): void => {
    if (state.frameLineCount === 0) return;
    write(`\u001B[${state.frameLineCount}F${ANSI.clearDown}`);
    state.frameLineCount = 0;
  };

  const redraw = (): void => {
    if (state.disposed) return;
    hideCursor();
    clearFrame();
    if (state.lines.length === 0) return;
    const painted = paintLiveLines(
      state.lines,
      currentSpinner(options.unicode, options.refreshIntervalMs),
      Date.now(),
      resolveColumns(options),
      options.color === true
    );
    write(`${painted.join("\n")}\n`);
    state.frameLineCount = painted.length;
  };

  const timer = setInterval(() => {
    if (
      state.disposed ||
      !state.lines.some(
        (line) => line.includes(SPINNER_TOKEN) || line.includes(SHIMMER_TOKEN_START)
      )
    ) {
      return;
    }
    redraw();
  }, options.refreshIntervalMs);

  return {
    setLines(lines) {
      state.lines = lines;
      redraw();
    },
    writeLog(text) {
      if (state.disposed) {
        write(text);
        return;
      }
      clearFrame();
      write(text);
      state.frameLineCount = 0;
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      clearInterval(timer);
      showCursor();
    },
  };
}

// CJS eval worker: paints independently of the pipeline thread.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const ANSI = {
  clearDown: "\\u001B[J",
  hideCursor: "\\u001B[?25l",
  reset: "\\u001B[0m",
  showCursor: "\\u001B[?25h",
};
const ANSI_STYLE = /\\u001B\\[[0-9;]*m/g;
const ANSI_STYLE_PREFIX = /^\\u001B\\[[0-9;]*m/;
const COMBINING_MARK = /\\p{Mark}/u;
const EMOJI = /\\p{Extended_Pictographic}/u;
const SHIMMER_BRIGHT = "\\u001B[0;1;36m";
const SHIMMER_DIM = "\\u001B[0;2;36m";
const frames = workerData.unicode
  ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  : ["-", "\\\\", "|", "/"];
const handshake = new Int32Array(workerData.handshakeBuffer);
let columns = workerData.columns;
function characterWidth(character) {
  if (COMBINING_MARK.test(character) || character === "\\u200D") return 0;
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
function visibleWidth(value) {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}
function fitLine(value, nextColumns) {
  if (!nextColumns || nextColumns <= 1) return value;
  const maxWidth = nextColumns - 1;
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
  return truncated + (hasStyle ? ANSI.reset : "") + "…";
}
function formatDurationMs(durationMs) {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) {
    const seconds = ms / 1000;
    return Number.isInteger(seconds) ? seconds + "s" : seconds.toFixed(1) + "s";
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds === 0 ? minutes + "m" : minutes + "m" + seconds + "s";
}
function paintShimmerText(text, nowMs) {
  const characters = [...text];
  if (characters.length === 0) return text;
  const widths = characters.map(characterWidth);
  const totalWidth = visibleWidth(text);
  const period = Math.max(1, totalWidth + 3);
  const head = Math.floor(nowMs / 80) % period;
  const bandStart = head - 2;
  let column = 0;
  let output = ANSI.reset;
  let last;
  for (let index = 0; index < characters.length; index++) {
    const width = widths[index];
    const inBand =
      width === 0 ? last === "bright" : column <= head && column + width - 1 >= bandStart;
    const style = inBand ? "bright" : "dim";
    if (style !== last) {
      output += style === "bright" ? SHIMMER_BRIGHT : SHIMMER_DIM;
      last = style;
    }
    output += characters[index];
    column += width;
  }
  return output + ANSI.reset;
}
function paint(lines, spinner, nowMs) {
  return lines.map((line) =>
    fitLine(
      line
        .replaceAll("\\u0001", spinner)
        .replace(/\\u0002(\\d+)\\u0003/g, (_, start) =>
          formatDurationMs(Math.max(0, nowMs - Number(start)))
        )
        .replace(/\\u0004(.*?)\\u0005/g, (_, text) =>
          workerData.color ? paintShimmerText(text, nowMs) : text
        ),
      columns
    )
  );
}
let lines = [];
let frameLineCount = 0;
let cursorHidden = false;
function write(chunk) {
  writeSync(workerData.fd, chunk);
}
function hideCursor() {
  if (cursorHidden) return;
  write(ANSI.hideCursor);
  cursorHidden = true;
}
function showCursor() {
  if (!cursorHidden) return;
  write(ANSI.showCursor);
  cursorHidden = false;
}
function clearFrame() {
  if (frameLineCount === 0) return;
  write("\\u001B[" + frameLineCount + "F" + ANSI.clearDown);
  frameLineCount = 0;
}
function currentSpinner() {
  return frames[Math.floor(Date.now() / workerData.refreshIntervalMs) % frames.length];
}
function redraw() {
  hideCursor();
  clearFrame();
  if (lines.length === 0) return;
  const painted = paint(lines, currentSpinner(), Date.now());
  write(painted.join("\\n") + "\\n");
  frameLineCount = painted.length;
}
function done() {
  Atomics.store(handshake, 0, 1);
  Atomics.notify(handshake, 0);
}
const timer = setInterval(() => {
  if (!lines.some((line) => line.includes("\\u0001") || line.includes("\\u0004"))) return;
  redraw();
}, workerData.refreshIntervalMs);
parentPort.on("message", (msg) => {
  if (msg.columns !== undefined) columns = msg.columns;
  if (msg.type === "lines") {
    lines = msg.lines;
    redraw();
    return;
  }
  if (msg.type === "log") {
    clearFrame();
    write(msg.text);
    frameLineCount = 0;
    return;
  }
  if (msg.type === "stop") {
    clearInterval(timer);
    if (msg.lines) lines = msg.lines;
    redraw();
    showCursor();
    done();
    parentPort.close();
  }
});
`;

function createWorkerTicker(options: LiveTickerOptions & { fd: number }): LiveTicker {
  const handshakeBuffer = new SharedArrayBuffer(4);
  const handshake = new Int32Array(handshakeBuffer);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      color: options.color === true,
      columns: resolveColumns(options),
      fd: options.fd,
      handshakeBuffer,
      refreshIntervalMs: options.refreshIntervalMs,
      unicode: options.unicode,
    },
  });
  let disposed = false;
  let lines: readonly string[] = [];

  const send = (message: TickerWorkerMessage): void => {
    if (disposed) return;
    worker.postMessage(message);
  };

  return {
    setLines(nextLines) {
      lines = nextLines;
      send({ columns: resolveColumns(options), lines: [...nextLines], type: "lines" });
    },
    writeLog(text) {
      if (disposed) {
        writeSync(options.fd, text);
        return;
      }
      send({ text, type: "log" });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      Atomics.store(handshake, 0, 0);
      worker.postMessage({
        columns: resolveColumns(options),
        lines: [...lines],
        type: "stop",
      });
      Atomics.wait(handshake, 0, 0, 500);
      try {
        writeSync(options.fd, ANSI.showCursor);
      } catch {
        // Stream may already be closed; cursor restore is best-effort.
      }
      void worker.terminate();
    },
  };
}

function outputFd(fd: number | undefined): fd is number {
  return fd !== undefined && Number.isInteger(fd) && fd >= 0;
}

/** Inline interval for tests; worker thread when `fd` is a real TTY/pipe. */
export function createLiveTicker(options: LiveTickerOptions): LiveTicker {
  if (outputFd(options.fd)) {
    try {
      return createWorkerTicker({ ...options, fd: options.fd });
    } catch {
      // Worker threads are unavailable in some embeddings; fall back.
    }
  }
  return createInlineTicker(options);
}
