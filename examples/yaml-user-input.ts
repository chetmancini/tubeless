import { createSteps, type StandardSchemaV1 } from "tubeless";
import { compilePipelineDocument, type ProjectRegistry } from "tubeless/project";
import document from "./declarative/user-input.yaml";

/** Application-owned requests; the adapter supplies terminal or browser rendering. */
export type ReviewInputRequest =
  | {
      kind: "choice";
      message: string;
      choices: readonly { value: "a" | "b" | "c"; label: string }[];
    }
  | { kind: "text"; message: string }
  | { kind: "confirm"; message: string };

const decisionSchema: StandardSchemaV1<unknown, "a" | "b" | "c"> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      value === "a" || value === "b" || value === "c"
        ? { value }
        : { issues: [{ message: "Choose a, b, or c" }] },
  },
};
const textSchema: StandardSchemaV1<unknown, string> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      typeof value === "string" && value.trim().length > 0
        ? { value: value.trim() }
        : { issues: [{ message: "Enter a non-empty note" }] },
  },
};
const yesNoSchema: StandardSchemaV1<unknown, boolean> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      typeof value === "boolean"
        ? { value }
        : { issues: [{ message: "Expected a boolean confirmation" }] },
  },
};

/** Return stable choice values and actual booleans, normalizing UI input in the adapter. */
export function createDeclarativeReviewPipeline(
  readInput: (request: ReviewInputRequest, signal?: AbortSignal) => Promise<unknown>
) {
  const { waitForInput } = createSteps<object>();
  const registry: ProjectRegistry = {
    steps: {
      prepareOutput: () => "xyz",
      askDecision: waitForInput("decision", {
        read: (_inputs, context) =>
          readInput(
            {
              kind: "choice",
              message: "Choose a review path",
              choices: [
                { value: "a", label: "Accept" },
                { value: "b", label: "Revise" },
                { value: "c", label: "Escalate" },
              ],
            },
            context.signal
          ),
      }).run,
      askText: waitForInput("note", {
        read: (_inputs, context) =>
          readInput({ kind: "text", message: "Add a review note" }, context.signal),
      }).run,
      confirmProceeding: waitForInput("approval", {
        read: ({ output }: Record<string, unknown>, context) => {
          if (typeof output !== "string") throw new Error("Expected the prepared output");
          return readInput(
            { kind: "confirm", message: `Output was ${output}. Confirm proceeding?` },
            context.signal
          );
        },
      }).run,
      // Substitute the application action here; this recipe only returns review data.
      proceed: ({ output, decision, note }) => ({ output, decision, note }),
    },
    schemas: { decision: decisionSchema, text: textSchema, yesNo: yesNoSchema },
    skipPredicates: {
      declined: ({ approval }) => (approval === false ? "User declined" : false),
    },
    finalizers: {
      // Absent approval means no answer (e.g. dry run), distinct from a deliberate false.
      reviewResult: ({ approval, proceed }) => ({
        approved: typeof approval === "boolean" ? approval : null,
        result: proceed ?? null,
      }),
    },
  };
  return compilePipelineDocument(document, registry).get("user-review");
}
