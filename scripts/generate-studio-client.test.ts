import { describe, expect, it } from "vitest";
import { compiledClientSource } from "./generate-studio-client.mjs";

describe("compiledClientSource", () => {
  it("strips the export and source map, then invokes initStudio", () => {
    const compiled = [
      "export function initStudio() {",
      "    const ready = true;",
      "}",
      `//# sourceMappingURL=${"studio-client.example.map"}`,
      "",
    ].join("\n");
    expect(compiledClientSource(compiled)).toBe(`function initStudio() {
    const ready = true;
}
initStudio();
`);
  });

  it("strips the supported initStudio and createStudioRunIndex exports", () => {
    const compiled = [
      "export function createStudioRunIndex(runs) {",
      "    return runs;",
      "}",
      "export function initStudio() {",
      "    const ready = true;",
      "}",
      "",
    ].join("\n");
    expect(compiledClientSource(compiled)).toBe(`function createStudioRunIndex(runs) {
    return runs;
}
function initStudio() {
    const ready = true;
}
initStudio();
`);
  });

  it("strips a combined named export of the two allowed functions", () => {
    const compiled = [
      "function createStudioRunIndex(runs) {",
      "    return runs;",
      "}",
      "function initStudio() {}",
      "export { createStudioRunIndex, initStudio };",
      "",
    ].join("\n");
    expect(compiledClientSource(compiled)).toBe(`function createStudioRunIndex(runs) {
    return runs;
}
function initStudio() {}
initStudio();
`);
  });

  it("rejects leftover module syntax", () => {
    expect(() =>
      compiledClientSource(`import { x } from "./x.js";\nexport function initStudio() {}\n`)
    ).toThrow(/import/);
    expect(() =>
      compiledClientSource(`export function initStudio() {}\nexport const leftover = 1;\n`)
    ).toThrow(/export/);
    expect(() =>
      compiledClientSource(
        `export function createStudioRunIndex() {}\nexport function initStudio() {}\nexport function leftover() {}\n`
      )
    ).toThrow(/export/);
    expect(() => compiledClientSource(`export function createStudioRunIndex() {}\n`)).toThrow(
      /export/
    );
    expect(() =>
      compiledClientSource(`export function initStudio() {}\nexport { initStudio };\n`)
    ).toThrow(/export/);
  });
});
