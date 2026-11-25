import { createSteps, definePipeline, type StandardSchemaV1 } from "tubeless";
import { defineProject } from "tubeless/project";

export const deploymentId = "runner-placement-v3";
export const runnerServiceId = "replace-with-runner-client-id.access";
export const transformId = "normalize-on-bun";
export const roundTripId = "local-file-via-worker";
export const workerChildId = "prefix-on-worker";

interface Options {
  text: string;
}
const textSchema: StandardSchemaV1<unknown, string> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected text." }] },
  },
};
const inputSchema: StandardSchemaV1<Options> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      value && typeof value === "object" && "text" in value && typeof value.text === "string"
        ? { value: { text: value.text } }
        : { issues: [{ message: "Expected a text field." }] },
    jsonSchema: {
      input: () => ({
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      }),
      output: () => ({
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      }),
    },
  },
};

const unavailable = (): never => {
  throw new Error("This handler belongs on the other runner.");
};
const normalize = (text: string) => text.trim().toUpperCase();

export function runnerProject(handlers: {
  fetch?: (key: string) => Promise<string>;
  publish?: (text: string) => Promise<void>;
  writeLocal?: (cwd: string, text: string, signal?: AbortSignal) => Promise<string>;
  readLocal?: (cwd: string, file: string, signal?: AbortSignal) => Promise<string>;
  saveLocal?: (cwd: string, text: string, signal?: AbortSignal) => Promise<void>;
  prefix?: (text: string, dryRun: boolean, signal?: AbortSignal) => Promise<string>;
}) {
  const { step, fromPipeline } = createSteps(inputSchema);
  const transform = step("transform", {
    async run(_inputs, context) {
      const text = await (handlers.writeLocal ?? unavailable)(
        context.cwd,
        normalize(context.options.text),
        context.signal
      );
      context.log.log("Local file transformed");
      context.reportProgress({ completed: 1, total: 1, message: "Local file ready" });
      return text;
    },
    dryRun: (_inputs, context) => normalize(context.options.text),
  });
  const local = definePipeline({
    id: transformId,
    implementationVersion: deploymentId,
    steps: [transform],
    finalize: transform,
    resultSchema: textSchema,
  });
  const fetchInput = step("fetch", {
    run: (_inputs, context) => (handlers.fetch ?? unavailable)(context.options.text),
  });
  const stage = fromPipeline("transform-locally", {
    pipeline: local,
    dependsOn: [fetchInput],
    mapOptions: ({ fetch }) => ({ text: fetch }),
  });
  const publishOutput = step("publish", {
    dependsOn: [stage],
    dryRun: "skip",
    run: async ({ "transform-locally": text }) => {
      await (handlers.publish ?? unavailable)(text);
      return text;
    },
  });
  const pipeline = definePipeline({
    id: "fetch-transform-publish",
    implementationVersion: deploymentId,
    steps: [fetchInput, stage, publishOutput],
    finalize: stage,
  });
  const addPrefix = step("add-prefix", {
    run: (_inputs, { options, signal }) =>
      (handlers.prefix ?? unavailable)(options.text, false, signal),
    dryRun: (_inputs, { options, signal }) =>
      (handlers.prefix ?? unavailable)(options.text, true, signal),
  });
  const workerChild = definePipeline({
    id: workerChildId,
    implementationVersion: deploymentId,
    steps: [addPrefix],
    resultSchema: textSchema,
  });
  const readLocal = step("read-local-file", {
    run: (_inputs, context) =>
      (handlers.readLocal ?? unavailable)(context.cwd, context.options.text, context.signal),
  });
  const runWorker = fromPipeline("prefix-in-cloudflare", {
    pipeline: workerChild,
    dependsOn: [readLocal],
    mapOptions: ({ "read-local-file": text }) => ({ text }),
  });
  const saveLocal = step("save-local-result", {
    dependsOn: [runWorker],
    dryRun: "skip",
    run: ({ "prefix-in-cloudflare": text }, context) =>
      (handlers.saveLocal ?? unavailable)(context.cwd, text, context.signal),
  });
  const roundTrip = definePipeline({
    id: roundTripId,
    implementationVersion: deploymentId,
    steps: [readLocal, runWorker, saveLocal],
    finalize: runWorker,
  });
  return defineProject("runner-placement", [pipeline, local, roundTrip, workerChild]);
}
