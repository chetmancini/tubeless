import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
  currentSpinner,
  paintLiveLines,
  hasLiveAnimation,
  TickerFrame,
} from "./live-ticker-frame.js";
import {
  TickerWorkerState,
  type LiveTickerWorkerData,
  type TickerWorkerMessage,
} from "./live-ticker-protocol.js";

const port = parentPort;
if (port === null) throw new Error("live-ticker-worker must run in a worker thread");

// SAFETY: createWorkerTicker owns the workerData shape.
const data = workerData as LiveTickerWorkerData;
const state = new TickerWorkerState(data.stateBuffer);
const frame = new TickerFrame((chunk) => writeSync(data.fd, chunk));
let columns = data.columns;
let lines: string[] = [];
let logPane: readonly string[] | undefined;

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
      frame.clear(columns);
      data.framePort.postMessage([]);
      writeSync(data.fd, message.text);
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
