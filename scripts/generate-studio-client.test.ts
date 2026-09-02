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

  it("rejects leftover module syntax", () => {
    expect(() =>
      compiledClientSource(`import { x } from "./x.js";\nexport function initStudio() {}\n`)
    ).toThrow(/import/);
    expect(() =>
      compiledClientSource(`export function initStudio() {}\nexport const leftover = 1;\n`)
    ).toThrow(/export/);
  });
});
