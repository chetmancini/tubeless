import { describe, expect, it } from "vitest";
import { compiledClientSource } from "./generate-studio-client.mjs";

describe("compiledClientSource", () => {
  it("preserves ESM exports, removes the source map, and invokes initStudio", async () => {
    const compiled = [
      "export let initialized = 0;",
      "export function initStudio() { initialized += 1; }",
      "function createStudioRunIndex(runs) { return runs; }",
      "export { createStudioRunIndex };",
      `//# sourceMappingURL=${"studio-client.example.map"}`,
      "",
    ].join("\n");
    const source = compiledClientSource(compiled);
    expect(source).not.toContain("sourceMappingURL");
    expect(source).toContain("export { createStudioRunIndex };");
    const client = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    expect(client.initialized).toBe(1);
    expect(client.createStudioRunIndex(["run-1"])).toEqual(["run-1"]);
  });

  it("does not append a second initialization call", () => {
    const compiled = "export function initStudio() {}\ninitStudio();\n";
    expect(compiledClientSource(compiled)).toBe(compiled);
  });

  it.each(['import { x } from "./x.js";', 'import "./x.js";', 'const x = import("./x.js");'])(
    "rejects imports requiring separate browser assets: %s",
    (statement) => {
      expect(() => compiledClientSource(`${statement}\nexport function initStudio() {}\n`)).toThrow(
        /import/
      );
    }
  );
});
