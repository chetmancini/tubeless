import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashDeclarationSurface,
  normalizeDeclarationSource,
  resolveSymbolDocumentation,
} from "./generate-api-reference.mjs";

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

  it("changes when a declaration is reached only through import()", () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-api-import-type-"));
    writeFileSync(
      join(root, "entry.d.ts"),
      `export type Pipeline = import("./types.js").Pipeline;\n`
    );
    writeFileSync(
      join(root, "types.d.ts"),
      "export interface Pipeline { run(options: object): void }\n"
    );
    writeFileSync(join(root, "unrelated.d.ts"), "export type Unused = { n: number };\n");
    const before = hashDeclarationSurface(join(root, "entry.d.ts"), root);

    writeFileSync(join(root, "unrelated.d.ts"), "export type Unused = { n: string };\n");
    expect(hashDeclarationSurface(join(root, "entry.d.ts"), root)).toBe(before);

    writeFileSync(
      join(root, "types.d.ts"),
      "export interface Pipeline { run(options: object, controls?: object): void }\n"
    );
    expect(hashDeclarationSurface(join(root, "entry.d.ts"), root)).not.toBe(before);
  });

  it("ignores comments, blank lines, and indentation", () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-api-comments-"));
    writeSurface(root, "export interface Pipeline { run(options: object): void }\n");
    const before = hashDeclarationSurface(join(root, "entry.d.ts"), root);

    writeSurface(
      root,
      [
        "/**",
        " * A pipeline.",
        " * @deprecated Use something else.",
        " */",
        "export interface Pipeline {",
        "  // Run the work.",
        "",
        "  run(options: object):",
        "    void",
        "}",
        "",
      ].join("\n")
    );
    expect(hashDeclarationSurface(join(root, "entry.d.ts"), root)).toBe(before);
  });

  it("ignores a declaration file named only by a comment", () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-api-comment-import-"));
    writeFileSync(
      join(root, "entry.d.ts"),
      [
        "/**",
        ' * A pipeline. See import("./unrelated.js") for an example.',
        " */",
        "export interface Pipeline { run(): void }",
        "",
      ].join("\n")
    );
    writeFileSync(join(root, "unrelated.d.ts"), "export type Unused = { n: number };\n");
    const before = hashDeclarationSurface(join(root, "entry.d.ts"), root);

    writeFileSync(join(root, "unrelated.d.ts"), "export type Unused = { n: string };\n");
    expect(hashDeclarationSurface(join(root, "entry.d.ts"), root)).toBe(before);
  });

  it("changes when a string literal type changes", () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-api-literal-"));
    writeSurface(root, 'export type Mode = "a";\n');
    const before = hashDeclarationSurface(join(root, "entry.d.ts"), root);

    writeSurface(root, 'export type Mode = "b";\n');
    expect(hashDeclarationSurface(join(root, "entry.d.ts"), root)).not.toBe(before);
  });
});

describe("normalizeDeclarationSource", () => {
  it("keeps comment-like text inside string and template literals", () => {
    const literals = 'type U = "http://x" | \'/* no */\' | `a//b${"}" | `x/*${N}`}/*c*/`;';
    expect(normalizeDeclarationSource(`${literals} // gone\n`)).toBe(literals);
  });

  it("removes doc comments and collapses whitespace", () => {
    expect(
      normalizeDeclarationSource("/** d */\nexport interface A {\n  /** x */\n  a: string;\n}\n")
    ).toBe("export interface A { a: string; }");
  });
});

describe("resolveSymbolDocumentation", () => {
  it("follows re-exports to the nearest summary and source declaration", () => {
    const entry = resolve("dist/core/pipeline.d.ts");

    expect(resolveSymbolDocumentation(entry, "PipelineContext")).toMatchObject({
      description: "Caller-supplied services and metadata shared by one pipeline execution.",
      source: { path: "src/core/pipeline-types.ts" },
    });
    expect(resolveSymbolDocumentation(entry, "createSteps")).toMatchObject({
      description: "Create typed step constructors for one pipeline definition.",
      source: { path: "src/core/pipeline-steps.ts" },
    });
  });
});
