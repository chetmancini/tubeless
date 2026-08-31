import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashDeclarationSurface } from "./generate-api-reference.mjs";

function writeSurface(root: string, types: string) {
  writeFileSync(join(root, "entry.d.ts"), `export type { Pipeline } from "./types.js";\n`);
  writeFileSync(join(root, "types.d.ts"), types);
  writeFileSync(join(root, "unrelated.d.ts"), "export type Unused = { n: number };\n");
}

describe("hashDeclarationSurface", () => {
  it("changes when a re-exported declaration changes and ignores siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-api-hash-"));
    writeSurface(root, "export interface Pipeline { run(options: object): void }\n");
    const before = hashDeclarationSurface(join(root, "entry.d.ts"), root);

    writeFileSync(join(root, "unrelated.d.ts"), "export type Unused = { n: string };\n");
    expect(hashDeclarationSurface(join(root, "entry.d.ts"), root)).toBe(before);

    writeSurface(
      root,
      "export interface Pipeline { run(options: object, controls?: object): void }\n"
    );
    expect(hashDeclarationSurface(join(root, "entry.d.ts"), root)).not.toBe(before);
  });
});
