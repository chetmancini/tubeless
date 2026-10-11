import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "./workbench-init.js";
import { cloudflareScaffold } from "./workbench-init-cloudflare.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const coreUrl = pathToFileURL(resolve("dist/core/pipeline.js")).href;
const projectUrl = pathToFileURL(resolve("dist/project/project.js")).href;

function projectSource(withSchema: boolean): string {
  return `
    import { createSteps, definePipeline } from ${JSON.stringify(coreUrl)};
    import { defineProject } from ${JSON.stringify(projectUrl)};
    const schema = { "~standard": { vendor: "t", version: 1, validate: (value) => ({ value }),
      jsonSchema: { input: () => ({ type: "object", properties: {} }) } } };
    const { step } = ${withSchema ? "createSteps(schema)" : "createSteps()"};
    const only = step("only", { run: () => 1 });
    export default defineProject("init-test", [definePipeline({ id: "only", steps: [only], finalize: only })]);
  `;
}

function workspace(source: string | null = projectSource(true)) {
  const cwd = mkdtempSync(join(tmpdir(), "My App_"));
  roots.push(cwd);
  if (source !== null) writeFileSync(join(cwd, "tubeless.project.mjs"), source);
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    cwd,
    stdout: { write: (chunk: string) => void out.push(chunk) },
    stderr: { write: (chunk: string) => void err.push(chunk) },
  };
  return { cwd, out, err, io };
}
const init = (io: ReturnType<typeof workspace>["io"], target = "cloudflare") =>
  runInit([target, "--project", "tubeless.project.mjs"], io);

describe("tubeless init", () => {
  it("writes the Cloudflare files and next steps", async () => {
    const { cwd, io, out } = workspace();
    expect(await init(io)).toBe(0);
    const worker = readFileSync(join(cwd, "cloudflare/worker.ts"), "utf8");
    expect(worker).toContain('import project from "../tubeless.project.mjs";');
    expect(worker).toContain('import { createCloudflareApp } from "tubeless/cloudflare";');
    const config = readFileSync(join(cwd, "cloudflare.config.ts"), "utf8");
    expect(config).toMatch(/name: "my-app-[a-z0-9-]+"/);
    expect(config).toContain('storage: "sqlite"');
    expect(out.join("")).toContain("npx cf deploy");
  });

  it("never overwrites existing files", async () => {
    const { cwd, io, err } = workspace();
    writeFileSync(join(cwd, "cloudflare.config.ts"), "keep");
    expect(await init(io)).not.toBe(0);
    expect(readFileSync(join(cwd, "cloudflare.config.ts"), "utf8")).toBe("keep");
    expect(existsSync(join(cwd, "cloudflare/worker.ts"))).toBe(false);
    expect(err.join("")).toContain("cloudflare.config.ts");
  });

  it("validates the project before writing anything", async () => {
    const schemaless = workspace(projectSource(false));
    expect(await init(schemaless.io)).not.toBe(0);
    expect(schemaless.err.join("")).toMatch(/Standard JSON Schema/);
    expect(existsSync(join(schemaless.cwd, "cloudflare.config.ts"))).toBe(false);
    const missing = workspace(null);
    expect(await init(missing.io)).not.toBe(0);
  });

  it("rejects unknown targets", async () => {
    const { io, err } = workspace();
    expect(await init(io, "aws")).not.toBe(0);
    expect(err.join("")).toContain("Available: cloudflare");
  });

  it("keeps the checked-in example identical to the scaffold output", () => {
    const root = resolve("examples/cloudflare");
    for (const file of cloudflareScaffold.files({
      cwd: root,
      projectFile: join(root, "tubeless.project.ts"),
    })) {
      expect(readFileSync(join(root, file.path), "utf8"), file.path).toBe(file.contents);
    }
  });
});
