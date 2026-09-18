import { writeSync } from "node:fs";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
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
  framePort: MessagePort;
  refreshIntervalMs: number;
  stateBuffer: SharedArrayBuffer;
  unicode: boolean;
}

type TickerWorkerMessage =
  | { columns?: number; lines: string[]; logPane?: readonly string[]; type: "lines" }
  | { columns?: number; text: string; type: "log" }
  | { columns?: number; lines: string[]; logPane?: readonly string[]; type: "stop" };

const port = parentPort;
if (port === null) throw new Error("live-ticker-worker must run in a worker thread");

// SAFETY: createWorkerTicker owns the workerData shape.
const data = workerData as LiveTickerWorkerData;
// [0] stopped, [1] accepted logs, [2] inline owns output, [3] output lock
const state = new Int32Array(data.stateBuffer);
const frame = new TickerFrame((chunk) => writeSync(data.fd, chunk));
let columns = data.columns;
let lines: string[] = [];
let logPane: readonly string[] | undefined;

function withOutputLock(write: () => void): void {
  while (Atomics.compareExchange(state, 3, 0, 1) !== 0) {
    Atomics.wait(state, 3, 1);
  }
  try {
    if (Atomics.load(state, 2) === 0) write();
  } finally {
    Atomics.store(state, 3, 0);
    Atomics.notify(state, 3);
  }
}

function paintFrame(): void {
  const painted = paintLiveLines(
    lines,
    currentSpinner(data.unicode, data.refreshIntervalMs),
    Date.now(),
    columns,
    data.color,
    data.unicode,
    logPane
  );
  frame.redraw(painted, columns);
  data.framePort.postMessage(painted);
}

function redraw(): void {
  withOutputLock(paintFrame);
}

const timer = setInterval(() => {
  if (Atomics.load(state, 2) === 1) {
    clearInterval(timer);
    port.close();
    return;
  }
  if (lines.some((line) => line.includes(SPINNER_TOKEN) || line.includes(SHIMMER_TOKEN_START))) {
    redraw();
  }
}, data.refreshIntervalMs);

port.on("message", (message: TickerWorkerMessage) => {
  if (Atomics.load(state, 2) === 1) {
    clearInterval(timer);
    port.close();
    return;
  }
  columns = message.columns ?? columns;
  if (message.type === "log") {
    withOutputLock(() => {
      frame.clear(columns);
      data.framePort.postMessage([]);
      writeSync(data.fd, message.text);
      Atomics.add(state, 1, 1);
    });
    return;
  }
  lines = message.lines;
  logPane = message.logPane;
  if (message.type === "lines") {
    redraw();
    return;
  }
  clearInterval(timer);
  try {
    withOutputLock(() => {
      paintFrame();
      frame.showCursor();
    });
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  } finally {
    port.close();
  }
});
