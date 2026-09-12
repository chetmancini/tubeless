import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
  TickerFrame,
  currentSpinner,
  paintLiveLines,
  SHIMMER_TOKEN_START,
  SPINNER_TOKEN,
} from "./live-ticker.js";

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
const frame = new TickerFrame((chunk) => writeSync(data.fd, chunk));
let announcedReady = false;

function publishFrame(): void {
  Atomics.store(handshake, 1, frame.frameLineCount);
}

function announceReady(): void {
  publishFrame();
  if (announcedReady || port === null) return;
  announcedReady = true;
  port.postMessage({ type: "ready", frameLineCount: frame.frameLineCount });
}

function redraw(): void {
  frame.redraw(
    paintLiveLines(
      lines,
      currentSpinner(data.unicode, data.refreshIntervalMs),
      Date.now(),
      columns,
      data.color
    )
  );
  publishFrame();
}

function done(): void {
  Atomics.store(handshake, 0, 1);
  Atomics.notify(handshake, 0);
}

const beat = (): void => {
  Atomics.add(handshake, 3, 1);
};

beat();
const timer = setInterval(() => {
  beat();
  if (!lines.some((line) => line.includes(SPINNER_TOKEN) || line.includes(SHIMMER_TOKEN_START))) {
    return;
  }
  redraw();
}, data.refreshIntervalMs);

port.on("message", (msg: TickerWorkerMessage) => {
  if (msg.type === "log") {
    frame.clear();
    writeSync(data.fd, msg.text);
    publishFrame();
    Atomics.add(handshake, 2, 1);
    announceReady();
    port.postMessage({ type: "ack", kind: "log" });
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
    frame.showCursor();
    done();
    port.close();
  }
});
