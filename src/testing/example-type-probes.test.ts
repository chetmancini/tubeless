import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";
import { NormalizePipeline } from "../../examples/child-pipeline.js";
import { ImportPipeline as CliImportPipeline } from "../../examples/cli-job.js";
import { ImportPipeline } from "../../examples/typed-import.js";
import { ValidatedPipeline } from "../../examples/validated-boundaries.js";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"]
): StandardSchemaV1<TInput, TOutput> {
  return {
    "~standard": {
      validate,
      vendor: "example",
      version: 1,
    },
  };
}

describe("example type probes", () => {
  it("keeps public example type errors in the test surface", () => {
    expect(ImportPipeline.id).toBe("import");
    expect(CliImportPipeline.id).toBe("import");
    expect(NormalizePipeline.id).toBe("normalize");
    expect(ValidatedPipeline.id).toBe("validated-import");

    // oxlint-disable-next-line no-constant-condition -- typecheck-only compile probe
    if (false) {
      // @ts-expect-error Pipeline step IDs stay literal, so typos fail typecheck.
      ImportPipeline.plan({ stepIds: ["normalise-rows"] });
      // @ts-expect-error Pipeline targets use only declared literal target IDs.
      ImportPipeline.plan({ targets: ["normalise-rows"] });
      // @ts-expect-error Existing internal step IDs are not automatically public targets.
      ImportPipeline.plan({ targets: ["load-rows"] });

      const missingLinesParams = { source: { type: "path" } } as const;
      // @ts-expect-error --source does not supply ImportPipeline's required lines option.
      definePipelineCommand(CliImportPipeline, { params: missingLinesParams });

      const renamedOptionalParams = {
        lines: { type: "string", multiple: true },
        max: { type: "number", optional: true },
      } as const;
      // @ts-expect-error --max is not a same-name option on ImportPipeline.
      definePipelineCommand(CliImportPipeline, { params: renamedOptionalParams });

      const { fromPipeline } = createSteps<{ lines: readonly string[] }>();
      fromPipeline("invalid-child-selection", {
        pipeline: NormalizePipeline,
        // @ts-expect-error Child run options are checked against its declared target IDs.
        mapOptions: () => ({ rows: [], targets: ["normalise-rows"] }),
      });

      const optionsSchema = standardSchema<{ source: string }, { limit: number; source: string }>(
        (value) => {
          // SAFETY: value is unvalidated external input; the optional `source` field is only
          // read so the typeof check below can validate it before any use.
          const source = (value as { source?: unknown }).source;
          return typeof source === "string"
            ? { value: { limit: 100, source } }
            : { issues: [{ message: "Expected a source path", path: ["source"] }] };
        }
      );
      const { step } = createSteps(optionsSchema);
      const load = step("load", {
        run: (_inputs, context) => [context.options.source].slice(0, context.options.limit),
      });

      // @ts-expect-error Options are inferred from the schema input.
      ValidatedPipeline.runOrThrow({});

      // SAFETY: an empty array literal has no elements that could violate readonly string[].
      const duplicate = step("load", { run: () => [] as readonly string[] });
      // @ts-expect-error Literal duplicate step IDs are rejected at definition time.
      definePipeline({ id: "duplicate", steps: [load, duplicate], finalize: () => undefined });
    }
  });
});
