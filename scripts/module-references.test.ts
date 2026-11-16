import { describe, expect, it } from "vitest";
import { moduleReferences } from "./module-references.js";

describe("module reference discovery", () => {
  it("includes imports, re-exports and literal lazy imports regardless of formatting", () => {
    expect(
      moduleReferences(`
        import { value } from /* source */ "./value.js";
        import /* side effect */ "./effect.js";
        export { value } from "./export.js";
        export * as namespace from "./namespace.js";
        const load = () => import(/* lazy */ "./lazy.js");
        const template = import(\`./literal.js\`);
        const escaped = import("./escaped\\u002ejs");
        const embedded = \`scaffold \${import("./embedded.js")}\`;
      `)
    ).toEqual([
      "./value.js",
      "./effect.js",
      "./export.js",
      "./namespace.js",
      "./lazy.js",
      "./literal.js",
      "./escaped.js",
      "./embedded.js",
    ]);
  });

  it("ignores comments and literal text, and marks computed imports as unknown", () => {
    expect(
      moduleReferences(`
        // import "./comment.js";
        /* export * from "./block-comment.js"; */
        const text = "import('./string.js')";
        const scaffold = \`import { value } from "./template.js";\`;
        const pattern = /import(".\\/pattern.js")/;
        const computed = import("./" + name);
        const variable = import(path);
      `)
    ).toEqual([undefined, undefined]);
  });

  it("follows declaration references without interpreting literal types as code", () => {
    expect(
      moduleReferences(`
        import type { Input } from "./input.js";
        import Legacy = require("./legacy.js");
        export type Result = import("./result.js").Result;
        export type Context = typeof import("./context.js");
        export type Message = 'import("./text.js")';
        export type Template = \`import("./template-text.js")\`;
      `)
    ).toEqual(["./input.js", "./legacy.js", "./result.js", "./context.js"]);
  });
});
