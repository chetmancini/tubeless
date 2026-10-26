import { readdir } from "node:fs/promises";
import { createSteps, definePipeline, type StandardSchemaV1 } from "tubeless";
import { defineAgent, type AgentModel } from "tubeless/agent";
import { definePipelineCommand } from "tubeless/cli";

interface Extracted {
  files: string[];
}
interface Triage {
  files: { path: string; kind: "empty" | "short" | "long" }[];
}

const extracted: StandardSchemaV1<Extracted> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      Array.isArray((value as Partial<Extracted>)?.files) &&
      (value as Extracted).files.every((file) => typeof file === "string")
        ? { value: value as Extracted }
        : { issues: [{ message: "Expected extracted file paths" }] },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { files: { type: "array", items: { type: "string" } } },
        required: ["files"],
      }),
    },
  },
};
const triage: StandardSchemaV1<Triage> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      Array.isArray((value as Partial<Triage>)?.files)
        ? { value: value as Triage }
        : { issues: [{ message: "Expected triaged files" }] },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                kind: { enum: ["empty", "short", "long"] },
              },
              required: ["path", "kind"],
              additionalProperties: false,
            },
          },
        },
        required: ["files"],
        additionalProperties: false,
      }),
    },
  },
};

/**
 * A credential-free stand-in that decides as a model would: read every file in one batch,
 * then classify the results. Replace it with `openaiModel()` or `anthropicModel()`; the agent
 * definition stays the same.
 */
const scriptedModel: AgentModel = (request) => {
  if (request.outcomes.length > 0)
    return {
      conversation: null,
      decision: {
        kind: "finish",
        result: {
          files: request.outcomes.map((outcome) => {
            const content = outcome.ok ? (outcome.value as { content: string }).content : "";
            const kind = content.trim() === "" ? "empty" : content.length < 80 ? "short" : "long";
            return { path: outcome.id, kind };
          }),
        },
      },
    };
  const paths = request.task
    .split("\n")
    .flatMap((line) => (line.startsWith("- ") ? [line.slice(2)] : []));
  return {
    conversation: null,
    decision: {
      kind: "continue",
      calls: paths.map((path) => ({
        id: path,
        tool: "read",
        input: { path, startLine: null, maxLines: null },
      })),
    },
  };
};

/** Typed in, typed out: the agent receives the extract step's output and returns a triage. */
export const TriageAgent = defineAgent({
  id: "triage-agent",
  description: "Classify extracted files from one batch of reads.",
  model: scriptedModel,
  inputSchema: extracted,
  resultSchema: triage,
  task: ({ files }) =>
    `Classify each extracted file as empty, short or long:\n${files.map((file) => `- ${file}`).join("\n")}`,
  // Read-only permission: the agent can read files but not write or run commands.
  defaultTools: ["read"],
  projectContext: false,
  limits: { maxTurns: 2, maxCalls: 50, maxConcurrency: 4 },
});

const { step, fromPipeline } = createSteps<{}>();

const extract = step("extract", {
  description: "List the text files in the run directory.",
  run: async (_inputs, context): Promise<Extracted> => ({
    files: (await readdir(context.cwd, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
      .map((entry) => entry.name)
      .sort(),
  }),
});
// The agent is an ordinary child pipeline; its typed options come from the extract step.
const classify = fromPipeline("classify", {
  pipeline: TriageAgent,
  dependsOn: [extract],
  mapOptions: ({ extract }) => extract,
});
const report = step("report", {
  dependsOn: [classify],
  description: "Consume the agent's typed result in ordinary pipeline work.",
  run: ({ classify }) => classify.files.map(({ path, kind }) => `${path}: ${kind}`).join("\n"),
});

export const ExtractTriagePipeline = definePipeline({
  id: "extract-triage",
  description: "Extract files, triage them with a typed agent, and report the result.",
  steps: [extract, classify, report],
  finalize: report,
});

export const ExtractTriageCommand = definePipelineCommand(ExtractTriagePipeline, {
  params: {},
  summarize: (result) => [result],
});
