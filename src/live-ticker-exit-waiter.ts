import { parentPort, workerData, type MessagePort } from "node:worker_threads";

interface ExitWaiterData {
  gateBuffer: SharedArrayBuffer;
  port: MessagePort;
}

// Port close fires during isolate teardown, a few milliseconds before the
// worker can no longer write. Park past the 80ms ownership window so the
// parent does not paint while the isolate is still live.
const ISOLATE_DRAIN_MS = 160;

// SAFETY: stopWorker always posts this exact workerData shape.
const data = workerData as ExitWaiterData;
const gate = new Int32Array(data.gateBuffer);

const signalExit = (): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ISOLATE_DRAIN_MS);
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
};

parentPort?.on("message", () => {});
data.port.on("message", () => {});
data.port.on("close", signalExit);
