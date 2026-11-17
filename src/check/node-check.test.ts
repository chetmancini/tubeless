import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNodeCheck, readNodeCheckPlan } from "./node-check.js";
import { runCheckProcess } from "./process.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const log = { log() {}, error() {}, warn() {} };
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "node-check-"));
  roots.push(cwd);
  await cp(new URL("../../scripts/fixtures/node-check/", import.meta.url), cwd, {
    recursive: true,
    filter: (path) => !path.includes("node_modules") && !path.includes(".tubeless-reports"),
  });
  return cwd;
}
describe("native recipe execution", () => {
  it("preserves nonzero exits, timeouts, cancellation and spawn failure", async () => {
    const context = { cwd: process.cwd(), log };
    expect(
      await runCheckProcess([process.execPath, "-e", "process.exit(7)"], 1000, context)
    ).toMatchObject({ status: "exited", exitCode: 7 });
    expect(await runCheckProcess(["sh", "-c", "sleep 30 & wait"], 20, context)).toMatchObject({
      status: "timed-out",
    });
    expect(await runCheckProcess(["/nonexistent-tubeless-command"], 1000, context)).toMatchObject({
      status: "spawn-failed",
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    expect(
      await runCheckProcess([process.execPath, "-e", "setTimeout(()=>{},30000)"], 5000, {
        ...context,
        signal: controller.signal,
      })
    ).toMatchObject({ status: "cancelled" });
  });
  it.runIf(process.platform !== "win32")(
    "bounds cancellation when a detached descendant retains output pipes",
    async () => {
      const cwd = await fixture(),
        pidFile = join(cwd, "descendant.pid");
      const program = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));console.log('descendant-ready');setTimeout(()=>{},30000);`;
      const controller = new AbortController();
      let cancelledAt: number | undefined;
      try {
        const result = await runCheckProcess([process.execPath, "-e", program], 5000, {
          cwd,
          signal: controller.signal,
          log: {
            ...log,
            log(message) {
              if (String(message).includes("descendant-ready")) {
                cancelledAt = performance.now();
                controller.abort();
              }
            },
          },
        });
        expect(result).toMatchObject({ status: "cancelled", outputComplete: false });
        expect(cancelledAt).toBeDefined();
        expect(performance.now() - cancelledAt!).toBeLessThan(2500);
      } finally {
        process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
      }
    },
    10000
  );
  it.runIf(process.versions.node.startsWith("24."))(
    "runs a complete clean gate and collects the original failing test once",
    async () => {
      const cwd = await fixture();
      const plan = await readNodeCheckPlan(cwd);
      const mutablePlan = structuredClone(plan);
      const pending = runNodeCheck(mutablePlan, { cwd, log });
      mutablePlan.commands[0].argv = ["/must-not-launch-mutated-plan"];
      mutablePlan.commands[1].dependsOn.push("changed-after-admission");
      const pass = await pending;
      expect(pass.run.status).toBe("completed");
      expect(pass.reports[0].result).toMatchObject({
        state: "available",
        report: { completeness: "complete", tests: [{ outcome: "passed" }] },
      });
      await writeFile(join(cwd, "app.js"), "export const answer = 41;\n");
      const fail = await runNodeCheck(plan, { cwd, log });
      expect(fail.run.status).toBe("failed");
      expect(fail.run.errors[0]).toMatchObject({
        code: "TUBELESS_STEP_FAILED",
        sourceCode: "NATIVE_PROCESS_FAILED",
      });
      expect(fail.commands.find((c) => c.id === "test")?.process).toMatchObject({
        status: "exited",
        exitCode: 1,
      });
      expect(fail.reports[0].result).toMatchObject({
        state: "available",
        report: {
          process: { exitCode: 1 },
          tests: [
            {
              title: "returns the expected answer",
              outcome: "failed",
              file: "app.test.js",
              line: 3,
            },
          ],
        },
      });
      expect(fail.commands.filter((c) => c.id === "test")).toHaveLength(1);
      const preview = await runNodeCheck(plan, { cwd, log }, { dryRun: true });
      expect(preview.commands).toEqual([]);
      expect(await readFile(join(cwd, "app.js"), "utf8")).toContain("41");
    },
    30000
  );
  it.runIf(process.versions.node.startsWith("24."))(
    "preserves failed prerequisites, skipped reports and pre-aborted cancellation",
    async () => {
      const cwd = await fixture();
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      manifest.scripts.types = "node -e 'process.exit(9)'";
      await writeFile(join(cwd, "package.json"), JSON.stringify(manifest));
      const plan = await readNodeCheckPlan(cwd);
      const failure = await runNodeCheck(plan, { cwd, log });
      expect(failure.run.status).toBe("failed");
      expect(failure.commands.find((c) => c.id === "types")?.process).toMatchObject({
        status: "exited",
        exitCode: 9,
      });
      expect(failure.commands.some((c) => c.id === "test")).toBe(false);
      expect(failure.reports[0].result).toEqual({ state: "missing" });
      expect(failure.run.steps.find((step) => step.id === "test")?.status).toBe("skipped");
      const cancelled = new AbortController();
      cancelled.abort();
      const result = await runNodeCheck(plan, { cwd, log, signal: cancelled.signal });
      expect(result.run.status).toBe("cancelled");
      expect(result.commands).toEqual([]);
    },
    30000
  );
});
