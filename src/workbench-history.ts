import { stat } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  projectPipelineRunStore,
  type PipelineRunEventQuery,
  type PipelineRunEventStore,
  type StoredPipelineEvent,
  type StoredPipelineRun,
} from "./run-store.js";
import {
  DEFAULT_PIPELINE_RUN_STORE,
  errorMessage,
  TUBELESS_WORKBENCH_EXIT_CODE,
  writeUsageError,
  type WorkbenchCliIo,
} from "./workbench-shared.js";

const HISTORY_USAGE = `Usage: tubeless history [options] [run-id]

Show recorded pipeline runs from the local SQLite store.

Options:
      --store <path>    SQLite database (default: .tubeless/runs.sqlite)
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
    },
    strict: true,
  });
}

async function listAllEvents(
  store: PipelineRunEventStore,
  query: PipelineRunEventQuery = {}
): Promise<StoredPipelineEvent[]> {
  const events: StoredPipelineEvent[] = [];
  let afterId: number | undefined;
  while (true) {
    const page = await store.listEvents({ ...query, afterId, limit: EVENT_PAGE_SIZE });
    if (page.length === 0) break;
    events.push(...page);
    afterId = page[page.length - 1]!.id;
    if (page.length < EVENT_PAGE_SIZE) break;
  }
  return events;
}

interface HistoryRunSummary {
  durationMs?: number;
  pipelineId: string;
  runId: string;
  startedAtMs: number;
  status: StoredPipelineRun["status"];
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
  return `${run.runId}  ${run.pipelineId}  ${run.status}  started ${started}${duration}`;
}

function formatRunDetail(run: StoredPipelineRun): string {
  const lines = [
    `Run ${run.runId}`,
    `Pipeline ${run.pipelineId}`,
    `Status ${run.status}`,
    `Started ${new Date(run.startedAtMs).toISOString()}`,
  ];
  if (run.durationMs !== undefined) lines.push(`Duration ${run.durationMs}ms`);
  lines.push("", "Steps:");
  for (const step of run.steps) {
    const duration = step.durationMs === undefined ? "" : `  ${step.durationMs}ms`;
    lines.push(`  ${step.id}  ${step.status}${duration}`);
  }
  lines.push("", "Logs:");
  for (const log of run.logs) {
    lines.push(`  [${log.level}] ${log.message}`);
  }
  if (run.error) {
    lines.push("", "Error:", `  ${run.error.code}  ${run.error.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function writeEvents(io: WorkbenchCliIo, events: readonly StoredPipelineEvent[]): void {
  for (const event of events) {
    io.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

export async function runHistory(argv: readonly string[], io: WorkbenchCliIo): Promise<number> {
  let parsed: ReturnType<typeof parseHistoryArgs>;
  try {
    parsed = parseHistoryArgs(argv);
  } catch (error) {
    return writeUsageError(io, errorMessage(error), HISTORY_USAGE);
  }

  if (parsed.values.help) {
    io.stdout.write(HISTORY_USAGE);
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  }
  if (parsed.values.json && parsed.values.events) {
    return writeUsageError(io, "Use --json or --events, not both.", HISTORY_USAGE);
  }
  if (parsed.positionals.length > 1) {
    return writeUsageError(io, "Pass at most one run id.", HISTORY_USAGE);
  }

  const runId = parsed.positionals[0];
  const filename = path.resolve(io.cwd, parsed.values.store ?? DEFAULT_PIPELINE_RUN_STORE);
  try {
    await stat(filename);
  } catch {
    io.stderr.write(`Error: Run store not found at ${filename}\n`);
    return TUBELESS_WORKBENCH_EXIT_CODE.load;
  }

  const { openSqlitePipelineRunStore } = await import("./run-store-sqlite.js");
  const store = await openSqlitePipelineRunStore(filename);
  try {
    const events = await listAllEvents(store, runId === undefined ? {} : { runId });
    if (parsed.values.events) {
      if (runId !== undefined && events.length === 0) {
        return writeUsageError(io, `Unknown run ${JSON.stringify(runId)}.`, HISTORY_USAGE);
      }
      writeEvents(io, events);
      return TUBELESS_WORKBENCH_EXIT_CODE.success;
    }

    const snapshot = projectPipelineRunStore(events);
    if (runId !== undefined) {
      const run = snapshot.runs.find((candidate) => candidate.runId === runId);
      if (!run) {
        return writeUsageError(io, `Unknown run ${JSON.stringify(runId)}.`, HISTORY_USAGE);
      }
      io.stdout.write(
        parsed.values.json ? `${JSON.stringify(run, null, 2)}\n` : formatRunDetail(run)
      );
      return TUBELESS_WORKBENCH_EXIT_CODE.success;
    }

    if (parsed.values.json) {
      io.stdout.write(`${JSON.stringify({ runs: snapshot.runs.map(summarizeRun) }, null, 2)}\n`);
      return TUBELESS_WORKBENCH_EXIT_CODE.success;
    }
    if (snapshot.runs.length > 0) {
      io.stdout.write(`${snapshot.runs.map(formatRunListLine).join("\n")}\n`);
    }
    return TUBELESS_WORKBENCH_EXIT_CODE.success;
  } finally {
    await store.close();
  }
}
