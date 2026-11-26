import { describe, expect, it } from "vitest";
import {
  decodeNodeCheckFileRequest,
  digestNodeCheckFileRequest,
  NODE_CHECK_FILE_LIMITS,
} from "../node-check-plan.js";

const selection = { version: 1, stepId: "test", mode: "selected" } as const;

describe("portable Vitest file requests", () => {
  it("normalizes a request before binding it to a plan digest", async () => {
    const request = { ...selection, files: ["test/z.test.js", "test/a.test.js"] };
    const decoded = decodeNodeCheckFileRequest(request);
    expect(decoded).toEqual({ ...selection, files: ["test/a.test.js", "test/z.test.js"] });
    expect(await digestNodeCheckFileRequest("plan", request)).toBe(
      await digestNodeCheckFileRequest("plan", decoded)
    );
    expect(await digestNodeCheckFileRequest("plan", request)).not.toBe(
      await digestNodeCheckFileRequest("other-plan", request)
    );
    expect(await digestNodeCheckFileRequest("plan", request)).not.toBe(
      await digestNodeCheckFileRequest("plan", { ...request, files: request.files.slice(1) })
    );
  });

  it.each([
    [],
    ["."],
    ["a//b.js"],
    ["a/../b.js"],
    ["a/./b.js"],
    ["C:/absolute.js"],
    ["a.test.js:3"],
    ["a.test.js", "a.test.js"],
    ["á.test.js", "a\u0301.test.js"],
    ["a\n.js"],
    [`${"é".repeat(512)}.js`],
  ])("rejects empty, noncanonical or colliding selections (%j)", (...files) => {
    expect(() => decodeNodeCheckFileRequest({ ...selection, files })).toThrow();
  });

  it("rejects lists over either the count or byte limit", () => {
    const inputs = [
      Array.from({ length: NODE_CHECK_FILE_LIMITS.files + 1 }, (_, index) => `${index}.js`),
      Array.from({ length: 1024 }, (_, index) => `${"p".repeat(600)}/${index}.js`),
    ];
    for (const files of inputs)
      expect(() => decodeNodeCheckFileRequest({ ...selection, files })).toThrow(/exceeds/);
  });
});
