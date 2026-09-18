import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
  currentSpinner,
  paintLiveLines,
  SHIMMER_TOKEN_START,
  SPINNER_TOKEN,
  TickerFrame,
} from "./live-ticker.js";

interface LiveTickerWorkerData {
  color: boolean;
  columns?: number;
  fd: number;
  refreshIntervalMs: number;
  stateBuffer: SharedArrayBuffer;
  unicode: boolean;
}

type TickerWorkerMessage =
  | { columns?: number; lines: string[]; type: "lines" }
  | { text: string; type: "log" }
  | { columns?: number; lines: string[]; type: "stop" };

const port = parentPort;
if (port === null) throw new Error("live-ticker-worker must run in a worker thread");

// SAFETY: createWorkerTicker owns the workerData shape.
const data = workerData as LiveTickerWorkerData;
// [0] stopped, [1] painted rows, [2] accepted logs, [3] inline owns output
const state = new Int32Array(data.stateBuffer);
const frame = new TickerFrame((chunk) => writeSync(data.fd, chunk));
let columns = data.columns;
let lines: string[] = [];

function redraw(): void {
  if (Atomics.load(state, 3) === 1) return;
  frame.redraw(
    paintLiveLines(
      lines,
      currentSpinner(data.unicode, data.refreshIntervalMs),
      Date.now(),
      columns,
      data.color
    )
  );
  Atomics.store(state, 1, frame.frameLineCount);
}

const timer = setInterval(() => {
  if (Atomics.load(state, 3) === 1) {
    clearInterval(timer);
    port.close();
    return;
  }
  if (lines.some((line) => line.includes(SPINNER_TOKEN) || line.includes(SHIMMER_TOKEN_START))) {
    redraw();
  }
}, data.refreshIntervalMs);

port.on("message", (message: TickerWorkerMessage) => {
  if (Atomics.load(state, 3) === 1) {
    clearInterval(timer);
    port.close();
    return;
  }
  if (message.type === "log") {
    frame.clear();
    Atomics.store(state, 1, 0);
    writeSync(data.fd, message.text);
    Atomics.add(state, 2, 1);
    return;
  }
  columns = message.columns ?? columns;
  lines = message.lines;
  if (message.type === "lines") {
    redraw();
    return;
  }
  clearInterval(timer);
  try {
    redraw();
    frame.showCursor();
  } finally {
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
    port.close();
  }
});
