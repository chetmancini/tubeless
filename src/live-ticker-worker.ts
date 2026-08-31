import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
  currentSpinner,
  paintLiveLines,
  SHIMMER_TOKEN_START,
  SPINNER_TOKEN,
} from "./live-ticker.js";

const ANSI = {
  clearDown: "\u001B[J",
  hideCursor: "\u001B[?25l",
  showCursor: "\u001B[?25h",
} as const;

interface LiveTickerWorkerData {
  color: boolean;
  columns?: number;
  fd: number;
  handshakeBuffer: SharedArrayBuffer;
  refreshIntervalMs: number;
  unicode: boolean;
}

type TickerWorkerMessage =
  | { columns?: number; lines: string[]; type: "lines" }
  | { text: string; type: "log" }
  | { columns?: number; lines: string[]; type: "stop" };

const port = parentPort;
if (port === null) {
  throw new Error("live-ticker-worker must run as a worker thread");
}

// SAFETY: createWorkerTicker always posts this exact workerData shape
// (color, columns, fd, handshakeBuffer, refreshIntervalMs, unicode).
const data = workerData as LiveTickerWorkerData;
const handshake = new Int32Array(data.handshakeBuffer);
let columns = data.columns;
let lines: string[] = [];
let frameLineCount = 0;
let cursorHidden = false;
let announcedReady = false;

function announceReady(): void {
  if (announcedReady || port === null) return;
  announcedReady = true;
  port.postMessage({ type: "ready" });
}

function write(chunk: string): void {
  writeSync(data.fd, chunk);
}

function hideCursor(): void {
  if (cursorHidden) return;
  write(ANSI.hideCursor);
  cursorHidden = true;
}

function showCursor(): void {
  if (!cursorHidden) return;
  write(ANSI.showCursor);
  cursorHidden = false;
}

function clearFrame(): void {
  if (frameLineCount === 0) return;
  write(`\u001B[${frameLineCount}F${ANSI.clearDown}`);
  frameLineCount = 0;
}

function redraw(): void {
  hideCursor();
  clearFrame();
  if (lines.length === 0) return;
  const painted = paintLiveLines(
    lines,
    currentSpinner(data.unicode, data.refreshIntervalMs),
    Date.now(),
    columns,
    data.color
  );
  write(`${painted.join("\n")}\n`);
  frameLineCount = painted.length;
}

function done(): void {
  Atomics.store(handshake, 0, 1);
  Atomics.notify(handshake, 0);
}

const timer = setInterval(() => {
  if (!lines.some((line) => line.includes(SPINNER_TOKEN) || line.includes(SHIMMER_TOKEN_START))) {
    return;
  }
  redraw();
}, data.refreshIntervalMs);

port.on("message", (msg: TickerWorkerMessage) => {
  if (msg.type === "log") {
    clearFrame();
    write(msg.text);
    frameLineCount = 0;
    announceReady();
    return;
  }
  if (msg.columns !== undefined) columns = msg.columns;
  if (msg.type === "lines") {
    lines = msg.lines;
    redraw();
    announceReady();
    return;
  }
  if (msg.type === "stop") {
    clearInterval(timer);
    if (msg.lines) lines = msg.lines;
    redraw();
    showCursor();
    done();
    port.close();
  }
});
