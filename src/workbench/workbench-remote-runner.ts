import { encodeAttemptBatches, encodeRunnerCompletion } from "../hosting/attempt/batch.js";
import { createLaunchTracing } from "../hosting/launch-tracing.js";
import type { PipelineExecutionJournal } from "../core/pipeline-types.js";
import { decodeJournalValue, encodeJournalValue } from "../hosting/journal-value.js";
import {
  hostedCommandContext,
  hostedProjectCommands,
  type HostedCommand,
} from "../hosting/hosting-commands.js";
import {
  RUNNER_HEARTBEAT_MS,
  RUNNER_JOURNAL_BYTES,
  RUNNER_JOURNAL_VERSION,
  RUNNER_LEASE_MS,
  RUNNER_PATH,
  RUNNER_REPLY_BYTES,
  boundedRunnerJson,
  decodeRunnerClaim,
  runnerProjectHeader,
  runnerChildControls,
  runnerValue,
  type RunnerClaim,
} from "../hosting/runner-protocol.js";
import { boundHostedEvent, executeHostedRun } from "../hosting/run.js";
import { BatchingTraceExporter } from "../hosting/trace-batching.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { AnyProjectPipeline } from "../project/pipeline-project.js";
import { abortableSleep, throwIfAborted } from "../utilities/abort.js";
import { isJsonObject } from "../utilities/canonical-json.js";
import { readBoundedBody } from "../utilities/read-body.js";
import { withRetry } from "../utilities/retry.js";
import { loadPipelineProjectFile } from "./workbench-project-loader.js";
import { errorMessage, terminalSafeText, type WorkbenchCliIo } from "./workbench-shared.js";

class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const retryable = (error: unknown) => !(error instanceof RunnerRequestError) || error.status >= 500;

type Send = (
  operation: string,
  payload: string | Uint8Array,
  signal?: AbortSignal,
  token?: string
) => Promise<Record<string, unknown>>;

function runnerTransport(fetcher: typeof fetch, host: string, headers: Headers): Send {
  return async (operation, payload, signal, token) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    if (token !== undefined) requestHeaders.set("x-tubeless-lease", token);
    const timeout = AbortSignal.timeout(4_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetcher(`${host}${RUNNER_PATH}/${operation}`, {
      method: "POST",
      headers: requestHeaders,
      body: payload as BodyInit,
      redirect: "manual",
      signal: deadline,
    });
    let result: unknown;
    try {
      const bytes = await readBoundedBody(
        response.body,
        operation === "journal" ? RUNNER_JOURNAL_BYTES : RUNNER_REPLY_BYTES,
        deadline
      );
      result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      if (response.ok) throw error;
    }
    if (!response.ok) {
      const detail =
        isJsonObject(result) && typeof result.message === "string" ? ` ${result.message}` : "";
      throw new RunnerRequestError(
        response.status,
        `Runner Worker returned HTTP ${response.status}.${detail}`
      );
    }
    if (!isJsonObject(result)) throw new Error("The Worker returned an invalid runner response.");
    return result;
  };
}

function remoteJournal(options: {
  key: string;
  token: string;
  send: Send;
  signal: AbortSignal;
  abandon(error: unknown): void;
}): PipelineExecutionJournal {
  const { key, token, send, signal, abandon } = options;
  const write = async (
    operation: "bind" | "begin" | "complete",
    path: readonly string[],
    value: unknown,
    intent?: { boundary: "effect" | "orchestration"; intentId: string }
  ) => {
    const body = JSON.stringify({
      id: key,
      token,
      operation,
      path,
      data: encodeJournalValue(value),
      ...intent,
    });
    try {
      const response = await withRetry(() => send("journal", body, signal), {
        signal,
        shouldRetry: retryable,
      });
      if (response.accepted === true) return response;
    } catch (error) {
      if (retryable(error)) abandon(error);
      throw error;
    }
    const error = new Error("The Worker no longer accepts this journal lease.");
    abandon(error);
    throw error;
  };
  return {
    key,
    bind: async (path, binding) => {
      await write("bind", path, binding);
    },
    begin: async (path, inputs, boundary) => {
      const response = await write("begin", path, inputs, {
        boundary,
        intentId: crypto.randomUUID(),
      });
      if (response.status === "new" || response.status === "incomplete")
        return { status: response.status };
      if (response.status === "completed" && typeof response.data === "string")
        return { status: "completed", value: decodeJournalValue(response.data) };
      throw new Error("The Worker returned an invalid journal acknowledgement.");
    },
    complete: async (path, value) => {
      await write("complete", path, value);
    },
  };
}

async function executeClaim(options: {
  claim: RunnerClaim;
  startedAt: number;
  entry: HostedCommand;
  pipeline: AnyProjectPipeline;
  io: WorkbenchCliIo;
  send: Send;
  signal: AbortSignal;
}): Promise<void> {
  const {
    claim: { job, token, remainingMs, recoveryAttemptId },
    startedAt,
    pipeline,
    entry,
    io,
    send,
    signal,
  } = options;
  const lease = JSON.stringify({ id: job.id, token });
  const controller = new AbortController();
  const keepAlive = new AbortController();
  const abandon = (error: unknown) => {
    // Local loss of ownership leaves recovery to the coordinator. Remote cancellation
    // still drains under the live lease and reports its terminal state when possible.
    if (recoveryAttemptId !== undefined) keepAlive.abort(error);
    controller.abort(error);
  };
  const cancelled = () => abandon(new DOMException("The runner was stopped.", "AbortError"));
  signal.addEventListener("abort", cancelled, { once: true });
  if (signal.aborted) cancelled();
  const remaining = remainingMs - (performance.now() - startedAt);
  const deadline = setTimeout(
    () =>
      controller.abort(new DOMException("The execution exceeded its deadline.", "TimeoutError")),
    Math.max(0, remaining)
  );
  let expiry: ReturnType<typeof setTimeout>;
  const renew = (requestStarted: number) => {
    clearTimeout(expiry);
    expiry = setTimeout(
      () => abandon(new Error("The local runner could not confirm its lease.")),
      Math.max(0, RUNNER_LEASE_MS - (performance.now() - requestStarted))
    );
  };
  renew(startedAt);
  const maintainLease = async () => {
    while (!keepAlive.signal.aborted) {
      await abortableSleep(RUNNER_HEARTBEAT_MS, keepAlive.signal, "Renew runner claim");
      const requestStarted = performance.now();
      try {
        const response = await send("heartbeat", lease, keepAlive.signal);
        if (response.active !== true) {
          abandon(new Error("The local runner claim expired."));
          return;
        }
        renew(requestStarted);
        if (response.cancelled === true)
          controller.abort(new DOMException("The execution was cancelled.", "AbortError"));
      } catch (error) {
        if (!retryable(error)) throw error;
        // The lease timer fences execution if transport cannot recover in time.
      }
    }
  };
  const heartbeat = maintainLease().catch((error: unknown) => {
    if (!keepAlive.signal.aborted) abandon(error);
  });
  const attemptId = recoveryAttemptId ?? job.id;
  let nextSequence = 0;
  const sendBatch = async (body: Uint8Array) => {
    const ack = await withRetry(() => send("events", body, keepAlive.signal, token), {
      maxAttempts: 3,
      baseDelayMs: 200,
      signal: keepAlive.signal,
      shouldRetry: retryable,
    });
    if (ack.accepted !== true) throw new Error("Studio rejected runner events.");
    nextSequence++;
  };
  const exporter = new BatchingTraceExporter(
    async (_sequence, events) => {
      for (const body of encodeAttemptBatches(
        attemptId,
        nextSequence,
        events.map(boundHostedEvent)
      ))
        await sendBatch(body);
    },
    { maxEvents: 50, maxDelayMs: 250, onFailure: abandon }
  );
  try {
    let terminalBatch: Uint8Array | undefined;
    let result: string | null = null;
    try {
      if (remaining <= 0 || performance.now() - startedAt >= RUNNER_LEASE_MS)
        controller.abort(new Error("The runner claim arrived after its deadline."));
      throwIfAborted(controller.signal, "Start runner attempt");
      if (job.kind === "root") {
        const parsed = entry.command.parseValues(
          job.run.values,
          hostedCommandContext(io, controller.signal)
        );
        if (parsed.kind !== "values")
          throw new Error(
            parsed.kind === "error" ? parsed.errors.join("\n") : "Help cannot be executed."
          );
        const run = await executeHostedRun({
          job: { ...job.run, maxRunDurationMs: Math.ceil(remaining) },
          entry,
          values: parsed.values,
          output: io,
          controller,
          exporter,
          ...(recoveryAttemptId === undefined
            ? {}
            : {
                recovery: {
                  deadlineAtMs: Date.now() + remaining,
                  journal: remoteJournal({
                    key: job.launchId,
                    token,
                    send,
                    signal: keepAlive.signal,
                    abandon,
                  }),
                },
              }),
        });
        if (recoveryAttemptId !== undefined && run.history.status === "complete") return;
        result =
          run.history.status === "complete"
            ? null
            : `The local pipeline exited (${run.exitCode}) without confirming a terminal run.`;
      } else {
        const { parentRunId, correlationId, itemKey, stepId, input, controls } = job.stage;
        let completion: PipelineTraceEvent | undefined;
        const stageExporter = {
          export(event: PipelineTraceEvent) {
            if (event.name === "pipeline.completed" && event.parentRunId === parentRunId)
              completion = event;
            else return exporter.export(event);
          },
          flush: () => exporter.flush(),
        };
        const tracing = createLaunchTracing({
          context: {
            pipelineId: pipeline.id,
            cwd: io.cwd,
            signal: controller.signal,
            launchId: job.launchId,
          },
          configurations: [entry.tracing],
          exporters: [stageExporter],
        });
        let report;
        try {
          report = await pipeline.run(input, runnerChildControls(controls), {
            cwd: io.cwd,
            log: console,
            signal: controller.signal,
            parentRunId,
            correlationId,
            tracing: {
              ...(tracing.prepare() ?? { exporter: stageExporter }),
              itemKey,
              parentStep: { runId: parentRunId, stepId },
            },
          });
        } finally {
          await tracing.close();
        }
        await exporter.flush();
        if (completion?.runId !== report.runId)
          throw new Error("The local stage did not record a terminal event.");
        const transferable =
          report.finalized && report.value !== undefined
            ? { ...report, value: runnerValue(report.value, "Remote stage result") }
            : report;
        boundedRunnerJson({ report: transferable }, "Remote stage result");
        terminalBatch = encodeRunnerCompletion(
          job.id,
          nextSequence,
          boundHostedEvent(completion),
          transferable
        );
      }
    } catch (error) {
      await exporter.flush().catch(() => {});
      result = errorMessage(error).slice(0, 2_000);
    }
    if (keepAlive.signal.aborted) return;
    if (terminalBatch) {
      await sendBatch(terminalBatch);
    } else {
      const ack = await send("finish", JSON.stringify({ id: job.id, token, result }));
      if (ack.accepted !== true)
        io.stderr.write(`Studio did not accept completion of local attempt ${job.id}.\n`);
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(expiry!);
    signal.removeEventListener("abort", cancelled);
    keepAlive.abort();
    await heartbeat;
  }
}

export async function runRemoteRunner(options: {
  host: string;
  projectFile: string;
  deploymentId: string;
  fetcher: typeof fetch;
  headers: Headers;
  signal: AbortSignal;
  io: WorkbenchCliIo;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<number> {
  const { host, projectFile, deploymentId, fetcher, headers, signal, io } = options;
  const loaded = await loadPipelineProjectFile(projectFile, io);
  if ("exitCode" in loaded) return loaded.exitCode;
  const commands = new Map(
    hostedProjectCommands(loaded.project).map((entry) => [entry.descriptor.id, entry])
  );
  const manifest = Object.fromEntries(
    [...commands].flatMap(([id, entry]) => {
      const identity = entry.command.plan().definition?.identity;
      return identity?.implementationVersion ? [[id, identity.definitionId]] : [];
    })
  );
  if (Object.keys(manifest).length === 0)
    throw new Error(
      "The runner project needs at least one pipeline with an implementationVersion."
    );
  const poll = boundedRunnerJson(
    { manifest, journalVersion: RUNNER_JOURNAL_VERSION },
    "Runner manifest"
  );
  headers.set("x-tubeless-project", runnerProjectHeader(loaded.project.id));
  headers.set("x-tubeless-deployment", deploymentId);
  const send = runnerTransport(fetcher, host, headers);
  const runnerIo = { ...io, cwd: loaded.cwd };
  let lastDiagnostic: string | undefined;
  io.stderr.write(`Waiting for local work from ${host} (${deploymentId}).\n`);
  try {
    while (!signal.aborted) {
      let diagnostic: string | undefined;
      let response: Record<string, unknown> | undefined;
      const startedAt = performance.now();
      try {
        response = await send("claim", poll, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (!retryable(error)) throw error;
        diagnostic = errorMessage(error);
      }
      if (response?.claim !== undefined) {
        const claim = decodeRunnerClaim(response.claim, deploymentId, manifest);
        const { pipelineId, id } = claim.job;
        const entry = commands.get(pipelineId);
        if (!entry) throw new Error("The claimed pipeline is unavailable.");
        const pipeline = loaded.project.get(pipelineId);
        try {
          await executeClaim({ claim, startedAt, entry, pipeline, io: runnerIo, send, signal });
        } catch (error) {
          if (!signal.aborted)
            io.stderr.write(`Local attempt ${id}: ${terminalSafeText(errorMessage(error))}\n`);
        }
        lastDiagnostic = undefined;
        continue;
      }
      if (typeof response?.diagnostic === "string") diagnostic = response.diagnostic;
      if (diagnostic !== lastDiagnostic && diagnostic)
        io.stderr.write(`${terminalSafeText(diagnostic)}\n`);
      lastDiagnostic = diagnostic;
      if (options.sleep) await options.sleep(RUNNER_HEARTBEAT_MS, signal);
      else await abortableSleep(RUNNER_HEARTBEAT_MS, signal, "Poll runner queue");
    }
    return 0;
  } catch (error) {
    if (!signal.aborted) throw error;
    return 0;
  }
}
