import { fork } from "node:child_process";
import type { CollectorRunJob, CollectorRunResult } from "../hosting/collector-run.js";
import { createCollectorTransport } from "../hosting/collector-transport.js";
import { abortableSleep, MAX_TIMEOUT_DELAY_MS } from "../utilities/abort.js";
import type {
  CollectorWorkerRequest,
  CollectorWorkerResponse,
  CollectorWorkerStart,
} from "./collector-worker-protocol.js";
import { collectorWorkerResponseSchema } from "./collector-worker-protocol.js";

export interface CollectorWorkerResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly outcome?: CollectorRunResult;
  readonly failureReport: "not-needed" | "recorded" | "closed" | "unconfirmed";
}

export function collectorWorkerBudgets(options: {
  readonly maxRunDurationMs: number;
  readonly startupTimeoutMs?: number;
  readonly cancelGraceMs?: number;
}) {
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const cancelGraceMs = options.cancelGraceMs ?? 1000;
  for (const delay of [startupTimeoutMs, cancelGraceMs, options.maxRunDurationMs])
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_TIMEOUT_DELAY_MS)
      throw new Error("Invalid worker supervision budget.");
  if (options.maxRunDurationMs === 0 || startupTimeoutMs === 0)
    throw new Error("Worker execution and startup budgets must be positive.");
  return { startupTimeoutMs, cancelGraceMs };
}

/** Supervise one OS process. Provision first; preserve launch/attempt IDs after uncertain dispatch. */
export function startCollectorWorker(options: {
  readonly job: CollectorRunJob;
  readonly baseUrl: string;
  readonly token: string;
  readonly deploymentId: string;
  /** Trusted compiled module; never taken from an ingest request or unvalidated job values. */
  readonly module: URL;
  readonly exportName?: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Bounds startup/claim, separately from the post-claim execution budget. */
  readonly startupTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  /** Parent-side control and failure-report transport. Child delivery uses native HTTPS. */
  readonly fetch?: typeof fetch;
}) {
  const { baseUrl, token, deploymentId, fetch: transportFetch } = options;
  const { startupTimeoutMs, cancelGraceMs } = collectorWorkerBudgets({
    ...options,
    maxRunDurationMs: options.job.maxRunDurationMs,
  });
  if (options.module.protocol !== "file:")
    throw new Error("Worker module must be a compiled file URL.");
  // Snapshot before fork, and keep credentials out of argv, environment and application values.
  const packet: CollectorWorkerStart = {
    type: "start",
    job: structuredClone(options.job),
    baseUrl,
    token,
    deploymentId,
    module: options.module.href,
    exportName: options.exportName,
  };
  const child = fork(new URL("./collector-worker-runtime.js", import.meta.url), [], {
    cwd: options.cwd,
    env: options.env,
    // This compiled entrypoint needs no parent eval, print, preload or loader flags.
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  let workerId: string | undefined;
  let outcome: CollectorRunResult | undefined;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const stop = new AbortController();
  const send = (message: CollectorWorkerRequest) => {
    if (child.connected) child.send(message, () => {});
  };
  const cancel = () => {
    if (stop.signal.aborted) return false;
    stop.abort();
    send({ type: "cancel" });
    forced = setTimeout(() => child.kill("SIGKILL"), cancelGraceMs);
    return true;
  };
  let deadline = setTimeout(cancel, startupTimeoutMs);
  async function pollCancellation(workerId: string): Promise<void> {
    const transport = createCollectorTransport({
      baseUrl,
      launchId: packet.job.launchId,
      workerId,
      token,
      fetch: transportFetch,
      signal: stop.signal,
    });
    while (!stop.signal.aborted) {
      try {
        if ((await transport.cancellationRequested(packet.job.attemptId)).cancelRequested) {
          cancel();
          return;
        }
      } catch {
        // Lost contact is neither a cancellation request nor proof of termination.
      }
      await abortableSleep(1000, stop.signal, "Worker supervision");
    }
  }
  // Ignore unrelated application IPC; only validated runtime messages affect supervision.
  child.on("message", (value: unknown) => {
    let message: CollectorWorkerResponse;
    try {
      message = collectorWorkerResponseSchema.decode(value, "worker");
    } catch {
      return;
    }
    if (message.type === "claimed" && workerId === undefined) {
      workerId = message.workerId;
      clearTimeout(deadline);
      deadline = setTimeout(cancel, packet.job.maxRunDurationMs);
      void pollCancellation(message.workerId).catch(() => {});
    } else if (message.type === "done") outcome = message.result;
  });
  child.on("error", () => {}); // The close result remains unconfirmed; never echo bootstrap secrets.
  const completed = new Promise<CollectorWorkerResult>((resolve) => {
    child.once("close", (code, signal) => {
      stop.abort();
      clearTimeout(deadline);
      clearTimeout(forced);
      void finish(code, signal).then(resolve);
    });
  });
  async function finish(
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<CollectorWorkerResult> {
    const result = { code, signal, ...(outcome === undefined ? {} : { outcome }) };
    if (code === 0 && (outcome?.status === "refused" || outcome?.status === "history-confirmed"))
      return { ...result, failureReport: "not-needed" };
    if (!workerId) return { ...result, failureReport: "unconfirmed" };
    try {
      const transport = createCollectorTransport({
        baseUrl,
        launchId: packet.job.launchId,
        workerId,
        token,
        fetch: transportFetch,
      });
      const { recorded } = await transport.reportFailure({
        attemptId: packet.job.attemptId,
        message: `Hosted worker exited before confirming its run history (code ${code}, signal ${signal}).`,
      });
      return { ...result, failureReport: recorded ? "recorded" : "closed" };
    } catch {
      return { ...result, failureReport: "unconfirmed" };
    }
  }
  send(packet);
  return { pid: child.pid, completed, cancel };
}
