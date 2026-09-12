import { describe, expect, it } from "vitest";
import { createJsonTraceExporter } from "./tracing-json.js";

describe("createJsonTraceExporter", () => {
  it("writes one structured event per JSON line", () => {
    const lines: string[] = [];
    const exporter = createJsonTraceExporter({ write: (line) => lines.push(line) });

    exporter.export({
      attributes: { attempt: 1 },
      name: "step.attempted",
      pipelineId: "import",
      runId: "run-1",
      stepId: "fetch",
      timestampMs: 42,
      version: 1,
    });

    expect(lines).toEqual([
      '{"attributes":{"attempt":1},"name":"step.attempted","pipelineId":"import","runId":"run-1","stepId":"fetch","timestampMs":42,"version":1}',
    ]);
  });
});
