import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import {
  createSteps,
  definePipeline,
  type PipelineExecutionJournal,
  type PipelineStepContext,
} from "tubeless";

// Node's type stripping executes this host in a genuinely separate process.
const { retainedJournal } = (await import(
  new URL("./execution-journal.test-support.ts", import.meta.url).href
)) as typeof import("./execution-journal.test-support.js");
const [mode, boundary, directory] = process.argv.slice(2) as [string, string, string];
const state = join(directory, "journal");
const records: Map<string, Buffer> = existsSync(state)
  ? new Map(deserialize(readFileSync(state)))
  : new Map();
const adapter = retainedJournal(records);
const persist = () => writeFileSync(state, serialize([...records]));
const journal: PipelineExecutionJournal = {
  ...adapter,
  async bind(...args) {
    await adapter.bind(...args);
    persist();
  },
  async begin(...args) {
    const result = await adapter.begin(...args);
    persist();
    return result;
  },
  async complete(...args) {
    await adapter.complete(...args);
    persist();
  },
};
const { step, waitForInput } = createSteps();
const first = step("first", {
  run: () => {
    appendFileSync(join(directory, "effects"), "first\n");
    return 1;
  },
});
const wait = async (_inputs: unknown, context: PipelineStepContext<{}>) => {
  if (boundary === "effect") appendFileSync(join(directory, "effects"), "uncertain\n");
  if (mode === "crash") {
    process.send?.({ ready: true, runId: context.runId });
    await new Promise<void>(() => {
      setInterval(() => {}, 1000);
    });
  }
  return 2;
};
const middle =
  boundary === "effect"
    ? step("middle", { dependsOn: [first], run: wait })
    : waitForInput("middle", { dependsOn: [first], read: wait });
const last = step("last", {
  dependsOn: [middle],
  run: () => {
    appendFileSync(join(directory, "effects"), "last\n");
    return 3;
  },
});
const pipeline = definePipeline({
  id: "process-journal",
  implementationVersion: "1",
  steps: [first, middle, last],
});
const result = await pipeline.run(
  {},
  {},
  { executionJournal: journal, log: { log() {}, warn() {}, error() {} } }
);
process.send?.({
  status: result.status,
  runId: result.runId,
  sourceCode: result.errors[0]?.sourceCode,
});
process.disconnect?.();
