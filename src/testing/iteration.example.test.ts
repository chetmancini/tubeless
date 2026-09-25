import { describe, expect, expectTypeOf, it } from "vitest";
import { PaginatedPipeline, runIterationExample } from "../../examples/iteration.js";

describe("iteration example", () => {
  it("collects complete and partial pages through public imports", async () => {
    expectTypeOf(PaginatedPipeline.runOrThrow).returns.resolves.toEqualTypeOf<readonly string[]>();
    expect(await runIterationExample()).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]);
    expect(await PaginatedPipeline.runOrThrow({ rows: [] })).toEqual([]);
    expect(await PaginatedPipeline.runOrThrow({ rows: ["one", "two"] })).toEqual(["one", "two"]);
  });
});
