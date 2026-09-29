import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { modelInstructions } from "./model-prompt.js";

const directories: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "tubeless-prompt-"));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it("loads root-to-cwd guidance, stops at worktree git files and excludes unrelated directories", async () => {
  const outside = await workspace();
  const root = join(outside, "repo");
  const cwd = join(root, "nested");
  await mkdir(join(cwd, "deeper"), { recursive: true });
  await writeFile(join(outside, "AGENTS.md"), "OUTSIDE");
  await writeFile(join(root, ".git"), "gitdir: elsewhere");
  await writeFile(join(root, "AGENTS.md"), "ROOT RULE");
  await writeFile(join(cwd, "AGENTS.md"), "NESTED RULE");
  await writeFile(join(cwd, "deeper", "AGENTS.md"), "DEEPER RULE");
  const prompt = await modelInstructions(cwd, "APP RULE", true);
  expect(prompt).toContain(cwd);
  expect(prompt.indexOf("ROOT RULE")).toBeLessThan(prompt.indexOf("NESTED RULE"));
  expect(prompt.indexOf("NESTED RULE")).toBeLessThan(prompt.indexOf("APP RULE"));
  expect(prompt).not.toContain("OUTSIDE");
  expect(prompt).not.toContain("DEEPER RULE");
  expect(await modelInstructions(cwd, undefined, false)).not.toContain("NESTED RULE");
});

it("uses cwd only outside a repository and allows missing instructions", async () => {
  const parent = await workspace();
  const cwd = join(parent, "workspace");
  await mkdir(cwd);
  await writeFile(join(parent, "AGENTS.md"), "OUTSIDE RULE");
  expect(await modelInstructions(cwd, undefined, true)).not.toContain("OUTSIDE RULE");
  await writeFile(join(cwd, "AGENTS.md"), "LOCAL RULE");
  expect(await modelInstructions(cwd, undefined, true)).toContain("LOCAL RULE");
});

it("fails on unreadable or oversized instructions rather than silently omitting them", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "AGENTS.md"), "x".repeat(16385));
  await expect(modelInstructions(cwd, undefined, true)).rejects.toThrow("exceed read limits");
  await rm(join(cwd, "AGENTS.md"));
  await mkdir(join(cwd, "AGENTS.md"));
  await expect(modelInstructions(cwd, undefined, true)).rejects.toThrow();
  await expect(modelInstructions(cwd, "x".repeat(32768), false)).rejects.toThrow(
    "instructions exceed"
  );
});

it("honors cancellation before context discovery", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel context");
  controller.abort(reason);
  await expect(modelInstructions("/missing", undefined, true, controller.signal)).rejects.toBe(
    reason
  );
});
