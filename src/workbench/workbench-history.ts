import { stat } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  createPipelineRunProjector,
  type PipelineRunEventQuery,
  type PipelineRunEventReader,
  type StoredPipelineEvent,
  type StoredPipelineRun,
} from "../run-store/run-store.js";
import {
  DEFAULT_PIPELINE_RUN_STORE,
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeCliChunk,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";
import { runWorkbenchSubcommand } from "./workbench-subcommand.js";

const HISTORY_USAGE = `Usage: tubeless history [options] [run-id]

Show recorded pipeline runs from SQLite or an NDJSON trace.

Options:
      --store <path>    SQLite database (default: .tubeless/runs.sqlite)
      --trace <path>    Read a finished NDJSON trace artifact
      --json            Emit the projected run list or run as JSON
      --events          Emit raw store events as NDJSON
  -h, --help            Show this help
`;

const EVENT_PAGE_SIZE = 20_000;

function parseHistoryArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      events: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      store: { type: "string" },
      trace: { type: "string" },
    },
    strict: true,
  });
}

async function forEachEventPage(
  store: PipelineRunEventReader,
  query: PipelineRunEventQuery,
  onPage: (page: readonly StoredPipelineEvent[]) => void | Promise<void>
): Promise<number> {
  let afterId: number | undefined;
  let eventCount = 0;
  while (true) {
    const page = await store.listEvents({ ...query, afterId, limit: EVENT_PAGE_SIZE });
    if (page.length === 0) break;
    eventCount += page.length;
    await onPage(page);
    afterId = page[page.length - 1]!.id;
    if (page.length < EVENT_PAGE_SIZE) break;
  }
  return eventCount;
}

interface HistoryRunSummary {
  durationMs?: number;
  pipelineId: string;
  runId: string;
  startedAtMs: number;
  status: StoredPipelineRun["status"];
}

function terminalSafeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}

function summarizeRun(run: StoredPipelineRun): HistoryRunSummary {
  const summary: HistoryRunSummary = {
    pipelineId: run.pipelineId,
    runId: run.runId,
    startedAtMs: run.startedAtMs,
    status: run.status,
  };
  if (run.durationMs !== undefined) summary.durationMs = run.durationMs;
  return summary;
}

function formatRunListLine(run: StoredPipelineRun): string {
  const started = new Date(run.startedAtMs).toISOString();
  const duration = run.durationMs === undefined ? "" : `  ${run.durationMs}ms`;
  return `${terminalSafeText(run.runId)}  ${terminalSafeText(run.pipelineId)}  ${run.status}  started ${started}${duration}`;
}

function formatRunDetail(run: StoredPipelineRun): string {
  const lines = [
    `Run ${terminalSafeText(run.runId)}`,
    `Pipeline ${terminalSafeText(run.pipelineId)}`,
    `Status ${run.status}`,
    `Started ${new Date(run.startedAtMs).toISOString()}`,
  ];
  if (run.durationMs !== undefined) lines.push(`Duration ${run.durationMs}ms`);
  lines.push("", "Steps:");
  for (const step of run.steps) {
    const duration = step.durationMs === undefined ? "" : `  ${step.durationMs}ms`;
    lines.push(`  ${terminalSafeText(step.id)}  ${step.status}${duration}`);
  }
  lines.push("", "Logs:");
  for (const log of run.logs) {
    lines.push(`  [${log.level}] ${terminalSafeText(log.message)}`);
  }
  if (run.error) {
    lines.push("", "Error:", `  ${run.error.code}  ${terminalSafeText(run.error.message)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeEvents(
  io: WorkbenchCliIo,
  events: readonly StoredPipelineEvent[]
): Promise<void> {
  for (const event of events) {
    await writeCliChunk(io.stdout, `${JSON.stringify(event)}\n`);
  }
}

export async function runHistory(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: HISTORY_USAGE,
      parse: parseHistoryArgs,
      async run(parsed, commandIo) {
        if (parsed.values.json && parsed.values.events) {
          return writeUsageError(commandIo, "Use --json or --events, not both.", HISTORY_USAGE);
        }
        if (parsed.values.store && parsed.values.trace) {
          return writeUsageError(commandIo, "Use --store or --trace, not both.", HISTORY_USAGE);
        }
        if (parsed.positionals.length > 1) {
          return writeUsageError(commandIo, "Pass at most one run id.", HISTORY_USAGE);
        }

        const runId = parsed.positionals[0];
        const filename = path.resolve(
          commandIo.cwd,
          parsed.values.trace ?? parsed.values.store ?? DEFAULT_PIPELINE_RUN_STORE
        );
        try {
          await stat(filename);
        } catch {
          commandIo.stderr.write(
            `Error: ${parsed.values.trace ? "Trace artifact" : "Run store"} not found at ${filename}\n`
          );
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        }

        let store: PipelineRunEventReader;
        try {
          if (parsed.values.trace) {
            const { openNdjsonPipelineRunStore } = await import("../run-store/run-store-ndjson.js");
            store = await openNdjsonPipelineRunStore(filename);
          } else {
            const { openSqlitePipelineRunStore } = await import("../run-store/run-store-sqlite.js");
            store = await openSqlitePipelineRunStore(filename, {
              initialize: false,
              readOnly: true,
            });
          }
        } catch (error) {
          commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        }
        const query: PipelineRunEventQuery = runId === undefined ? {} : { runId };
        try {
          if (parsed.values.events) {
            const eventCount = await forEachEventPage(store, query, (page) =>
              writeEvents(commandIo, page)
            );
            if (runId !== undefined && eventCount === 0) {
              return writeUsageError(
                commandIo,
                `Unknown run ${JSON.stringify(runId)}.`,
                HISTORY_USAGE
              );
            }
            return TUBELESS_WORKBENCH_EXIT_CODE.success;
          }

          const projector = createPipelineRunProjector({ retainLogs: runId !== undefined });
          await forEachEventPage(store, query, (page) => projector.append(page));
          const snapshot = projector.snapshot();
          if (runId !== undefined) {
            const run = snapshot.runs.find((candidate) => candidate.runId === runId);
            if (!run) {
              return writeUsageError(
                commandIo,
                `Unknown run ${JSON.stringify(runId)}.`,
                HISTORY_USAGE
              );
            }
            await writeCliChunk(
              commandIo.stdout,
              parsed.values.json ? `${JSON.stringify(run, null, 2)}\n` : formatRunDetail(run)
            );
            return TUBELESS_WORKBENCH_EXIT_CODE.success;
          }

          if (parsed.values.json) {
            await writeCliChunk(
              commandIo.stdout,
              `${JSON.stringify({ runs: snapshot.runs.map(summarizeRun) }, null, 2)}\n`
            );
            return TUBELESS_WORKBENCH_EXIT_CODE.success;
          }
          if (snapshot.runs.length > 0) {
            await writeCliChunk(
              commandIo.stdout,
              `${snapshot.runs.map(formatRunListLine).join("\n")}\n`
            );
          }
          return TUBELESS_WORKBENCH_EXIT_CODE.success;
        } catch (error) {
          commandIo.stderr.write(`Error: ${errorMessage(error)}\n`);
          return TUBELESS_WORKBENCH_EXIT_CODE.load;
        } finally {
          await store.close();
        }
      },
    },
    argv,
    io
  );
}
