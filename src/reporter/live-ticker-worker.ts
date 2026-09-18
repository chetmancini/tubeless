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
  stopBuffer: SharedArrayBuffer;
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
const stopped = new Int32Array(data.stopBuffer);
const frame = new TickerFrame((chunk) => writeSync(data.fd, chunk));
let columns = data.columns;
let lines: string[] = [];

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
}

const timer = setInterval(() => {
  if (lines.some((line) => line.includes(SPINNER_TOKEN) || line.includes(SHIMMER_TOKEN_START))) {
    redraw();
  }
}, data.refreshIntervalMs);

port.on("message", (message: TickerWorkerMessage) => {
  if (message.type === "log") {
    frame.clear();
    writeSync(data.fd, message.text);
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
    Atomics.store(stopped, 0, 1);
    Atomics.notify(stopped, 0);
    port.close();
  }
});
