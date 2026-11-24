import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { hasLiveAnimation, paintTickerLines, TickerFrame } from "./frame.js";
import {
  TickerWorkerState,
  type LiveTickerWorkerData,
  type TickerWorkerMessage,
} from "./protocol.js";

const port = parentPort;
if (port === null) throw new Error("live-ticker-worker must run in a worker thread");

// SAFETY: createWorkerTicker owns the workerData shape.
const data = workerData as LiveTickerWorkerData;
const state = new TickerWorkerState(data.stateBuffer);
const frame = new TickerFrame((chunk) => writeSync(data.fd, chunk));
let columns = data.columns;
let lines: string[] = [];
let logPane: readonly string[] | undefined;

function paintFrame(above?: string): void {
  const painted = paintTickerLines(lines, data, columns, logPane);
  frame.redraw(painted, columns, above);
  data.framePort.postMessage(painted);
}

function redraw(): void {
  state.withWorkerOutput(paintFrame);
}

const timer = setInterval(() => {
  if (state.inlineRequested) {
    clearInterval(timer);
    port.close();
    return;
  }
  if (hasLiveAnimation(lines)) {
    redraw();
  }
}, data.refreshIntervalMs);

port.on("message", (message: TickerWorkerMessage) => {
  if (state.inlineRequested) {
    clearInterval(timer);
    port.close();
    return;
  }
  columns = message.columns ?? columns;
  if (message.type === "log") {
    state.withWorkerOutput(() => {
      paintFrame(message.text);
      state.acknowledgeLog();
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
    state.withWorkerOutput(() => {
      paintFrame();
      frame.showCursor();
    });
    state.markStopped();
  } finally {
    port.close();
  }
});
