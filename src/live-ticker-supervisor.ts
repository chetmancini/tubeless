import { parentPort, workerData, Worker } from "node:worker_threads";

interface SupervisorTickerData {
  color: boolean;
  columns?: number;
  fd: number;
  handshakeBuffer: SharedArrayBuffer;
  refreshIntervalMs: number;
  unicode: boolean;
}

interface SupervisorData {
  controlBuffer: SharedArrayBuffer;
  execArgv: string[];
  tickerData: SupervisorTickerData;
  tickerUrl: string;
}

type TickerInboundMessage =
  | { columns?: number; lines: string[]; type: "lines" }
  | { text: string; type: "log" }
  | { columns?: number; lines: string[]; type: "stop" };

type TickerOutboundMessage =
  | { kind: "log"; type: "ack" }
  | { frameLineCount?: number; type: "ready" };

// [0] terminate request, [1] ticker isolate exited
// SAFETY: createWorkerTicker always posts this exact workerData shape.
const data = workerData as SupervisorData;
const control = new Int32Array(data.controlBuffer);
const port = parentPort;
if (port === null) {
  throw new Error("live-ticker-supervisor must run as a worker thread");
}

const ticker = new Worker(new URL(data.tickerUrl), {
  execArgv: data.execArgv,
  workerData: data.tickerData,
});

const recordExit = (): void => {
  Atomics.store(control, 1, 1);
  Atomics.notify(control, 1);
};

ticker.on("message", (msg: TickerOutboundMessage) => {
  port.postMessage(msg);
});
ticker.on("error", () => {
  port.postMessage({ event: "error", type: "supervisor" });
});
ticker.on("exit", (code: number) => {
  recordExit();
  port.postMessage({ code, event: "exit", type: "supervisor" });
});
ticker.unref();

const stopTimer = setInterval(() => {
  if (Atomics.load(control, 0) !== 1) return;
  clearInterval(stopTimer);
  void ticker.terminate();
}, 1);
stopTimer.unref();

port.on("message", (msg: TickerInboundMessage) => {
  ticker.postMessage(msg);
});
