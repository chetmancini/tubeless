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
  workerUrl?: URL;
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

export function currentSpinner(unicode: boolean, refreshIntervalMs: number): string {
  const frames = unicode ? SPINNERS.unicode : SPINNERS.ascii;
  return frames[Math.floor(Date.now() / refreshIntervalMs) % frames.length] ?? frames[0]!;
}

function createInlineTicker(options: LiveTickerOptions, adoptedFrameLineCount = 0): LiveTicker {
  const state: TickerState = {
    cursorHidden: adoptedFrameLineCount > 0,
    disposed: false,
    frameLineCount: adoptedFrameLineCount,
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
  timer.unref();

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

function resolveLiveTickerWorkerUrl(): URL {
  if (import.meta.url.endsWith(".ts")) {
    return new URL("../dist/live-ticker-worker.js", import.meta.url);
  }
  return new URL("./live-ticker-worker.js", import.meta.url);
}

function fileWorkerExecArgv(argv: readonly string[] = process.execArgv): string[] {
  const next: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input-type") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--input-type=")) continue;
    next.push(arg);
  }
  return next;
}

function createWorkerTicker(options: LiveTickerOptions & { fd: number }): LiveTicker {
  // [0] stop handshake, [1] painted rows, [2] accepted logs
  const handshakeBuffer = new SharedArrayBuffer(12);
  const handshake = new Int32Array(handshakeBuffer);
  const worker = new Worker(options.workerUrl ?? resolveLiveTickerWorkerUrl(), {
    execArgv: fileWorkerExecArgv(),
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
  let finalFramePainted = false;
  let inlineFallback: LiveTicker | undefined;
  let lines: readonly string[] = [];
  const pendingLogs: string[] = [];
  let ackedLogs = 0;

  const paintedFrameLineCount = (): number => Atomics.load(handshake, 1);

  const dropAcknowledgedLogs = (): void => {
    const accepted = Atomics.load(handshake, 2);
    if (accepted <= ackedLogs) return;
    pendingLogs.splice(0, accepted - ackedLogs);
    ackedLogs = accepted;
  };

  const send = (message: TickerWorkerMessage): void => {
    if (disposed || inlineFallback) return;
    worker.postMessage(message);
  };

  const stopWorker = (): void => {
    void worker.terminate();
    const deadline = Date.now() + 1_000;
    while (worker.threadId !== -1 && Date.now() < deadline) {
      // terminate() stops the isolate; threadId becomes -1 without the event loop.
    }
  };

  const replayThrough = (ticker: LiveTicker): void => {
    dropAcknowledgedLogs();
    for (const text of pendingLogs) {
      ticker.writeLog(text);
    }
    pendingLogs.length = 0;
    ticker.setLines([...lines]);
  };

  const paintFinalFrame = (): void => {
    if (finalFramePainted) return;
    finalFramePainted = true;
    try {
      const ticker = createInlineTicker(options, paintedFrameLineCount());
      replayThrough(ticker);
      ticker.dispose();
    } catch {
      // Stream may already be closed after dispose.
    }
  };

  const failToInline = (): void => {
    if (inlineFallback || finalFramePainted) return;
    if (disposed) {
      if (Atomics.load(handshake, 0) !== 1) paintFinalFrame();
      return;
    }
    inlineFallback = createInlineTicker(options, paintedFrameLineCount());
    replayThrough(inlineFallback);
  };
  worker.on("error", failToInline);
  worker.on("exit", (code) => {
    if (code !== 0) failToInline();
  });
  worker.unref();
  worker.on("message", (msg: { type?: string; kind?: string }) => {
    if (msg?.type === "ack" && msg.kind === "log") dropAcknowledgedLogs();
  });

  return {
    setLines(nextLines) {
      lines = nextLines;
      if (inlineFallback) {
        inlineFallback.setLines(nextLines);
        return;
      }
      send({ columns: resolveColumns(options), lines: [...nextLines], type: "lines" });
    },
    writeLog(text) {
      if (inlineFallback) {
        inlineFallback.writeLog(text);
        return;
      }
      if (disposed) {
        writeSync(options.fd, text);
        return;
      }
      dropAcknowledgedLogs();
      pendingLogs.push(text);
      send({ text, type: "log" });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (inlineFallback) {
        inlineFallback.dispose();
        void worker.terminate();
        return;
      }
      Atomics.store(handshake, 0, 0);
      try {
        worker.postMessage({
          columns: resolveColumns(options),
          lines: [...lines],
          type: "stop",
        });
      } catch {
        stopWorker();
        paintFinalFrame();
        return;
      }
      if (Atomics.wait(handshake, 0, 0, 500) === "timed-out") {
        stopWorker();
        paintFinalFrame();
        try {
          writeSync(options.fd, ANSI.showCursor);
        } catch {
          // Stream may already be closed; cursor restore is best-effort.
        }
        return;
      }
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
