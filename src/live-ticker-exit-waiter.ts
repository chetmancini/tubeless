import { parentPort, workerData, type MessagePort } from "node:worker_threads";

interface ExitWaiterData {
  gateBuffer: SharedArrayBuffer;
  port: MessagePort;
}

// SAFETY: stopWorker always posts this exact workerData shape.
const data = workerData as ExitWaiterData;
const gate = new Int32Array(data.gateBuffer);

parentPort?.on("message", () => {});
data.port.on("message", () => {});
data.port.on("close", () => {
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
});
