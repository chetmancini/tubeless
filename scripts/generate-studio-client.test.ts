import { describe, expect, it } from "vitest";
import { cloudflareClientModule, compiledClientSource } from "./generate-studio-client.mjs";

describe("compiledClientSource", () => {
  it("preserves ESM exports, removes the source map, and keeps entrypoint side effects", async () => {
    const compiled = [
      "export let initialized = 0;",
      "export function initStudio() { initialized += 1; }",
      "function createStudioRunIndex(runs) { return runs; }",
      "export { createStudioRunIndex };",
      "initStudio();",
      `//# sourceMappingURL=${"studio-client.example.map"}`,
      "",
    ].join("\n");
    const source = compiledClientSource(compiled);
    expect(source).not.toContain("sourceMappingURL");
    const client = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    expect(client.initialized).toBe(1);
    expect(client.createStudioRunIndex(["run-1"])).toEqual(["run-1"]);
  });

  it("does not invent an initialization call", () => {
    const compiled = "export function initStudio() {}\n";
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

describe("cloudflareClientModule", () => {
  it("exports the client source without changing its contents", async () => {
    const source = 'a"b\n</script>\u2028';
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(cloudflareClientModule(source)).toString("base64")}`
    );
    expect(module.PIPELINE_RUN_STUDIO_CLIENT).toBe(source);
  });
});
