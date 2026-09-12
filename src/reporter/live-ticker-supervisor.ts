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
  | { columns?: number; lines: string[]; type: "stop" }
  | { type: "terminate" };

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

let terminated = false;

const recordExit = (): void => {
  Atomics.store(control, 1, 1);
  Atomics.notify(control, 1);
};

const terminateTicker = (): void => {
  if (terminated) return;
  terminated = true;
  Atomics.store(control, 0, 1);
  void ticker.terminate();
};

ticker.on("message", (msg: TickerOutboundMessage) => {
  port.postMessage(msg);
});
ticker.on("error", () => {
  port.postMessage({ event: "error", terminated, type: "supervisor" });
});
ticker.on("exit", (code: number) => {
  recordExit();
  port.postMessage({ code, event: "exit", terminated, type: "supervisor" });
});
ticker.unref();

port.on("message", (msg: TickerInboundMessage) => {
  if (msg.type === "terminate") {
    terminateTicker();
    return;
  }
  ticker.postMessage(msg);
});
