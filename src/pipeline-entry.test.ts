import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pipelineSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "pipeline.ts"),
  "utf8"
);

describe("pipeline entrypoint imports", () => {
  it("does not import reporter or render modules", () => {
    expect(pipelineSource).not.toMatch(/from ["']\.\/reporter\.js["']/);
    expect(pipelineSource).not.toMatch(/from ["']\.\/interactive-reporter\.js["']/);
    expect(pipelineSource).not.toMatch(/from ["']\.\/render\.js["']/);
  });
});
