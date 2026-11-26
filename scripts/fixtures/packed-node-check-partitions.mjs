import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(join(process.cwd(), "package.json"));
const { readNodeCheckPlan, runNodeCheckFiles, runNodeCheckPartitions } = await import(
  pathToFileURL(require.resolve("tubeless/node/check"))
);
const { planNodeCheckPartitions, digestNodeCheckPartitionPlan, verifyNodeCheckPartitionCoverage } =
  await import(pathToFileURL(require.resolve("tubeless/check-plan")));

const cwd = await mkdtemp(join(await realpath(tmpdir()), "tubeless-packed-partitions-"));
const log = { log() {}, warn() {}, error() {} };

try {
  for (const fixture of ["node-check", "node-check-files"])
    await cp(new URL(`./${fixture}/`, import.meta.url), cwd, {
      recursive: true,
      filter: (path) => !path.endsWith("node_modules") && !path.endsWith(".tubeless-reports"),
    });

  const manifestFile = join(cwd, "package.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.scripts.types += " && node marker.js before";
  manifest.scripts.after = "node marker.js after";
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(
    join(cwd, "marker.js"),
    `import { appendFileSync, existsSync } from "node:fs";
     appendFileSync("graph.log", process.argv[2] + "\\n");
     if (process.argv[2] === "after" && existsSync("fail-downstream")) process.exitCode = 1;`
  );
  const recipeFile = join(cwd, "tubeless.check.json");
  const recipe = JSON.parse(await readFile(recipeFile, "utf8"));
  recipe.checks.push({ id: "after", script: "after", dependsOn: ["test"] });
  await writeFile(recipeFile, JSON.stringify(recipe));

  const setup = join(cwd, "global-setup.js");
  const workingSetup = `import { appendFileSync } from "node:fs";
    export default function setup(project) {
      appendFileSync("graph.log", "setup\\n");
      project.provide("gate", "global setup ran");
    }`;
  await writeFile(setup, workingSetup);

  const plan = await readNodeCheckPlan(cwd);
  const config = join(cwd, "vitest.config.js");
  const originalConfig = await readFile(config, "utf8");
  const executed = join(cwd, "executed.log");
  const graph = join(cwd, "graph.log");
  const files = ["spec/archive.case.js", "spec/check.case.js"];
  const bad = "spec/nested/spec/check.case.js";
  const base = { version: 1, stepId: "test" };
  const selection = { ...base, mode: "selected", files };
  const discover = async () => {
    const result = await runNodeCheckFiles(plan, { cwd, log }, { ...base, mode: "inventory" });
    assert.equal(result.fileCheck.outcome, "inventory-complete", JSON.stringify(result.run.errors));
    await rm(graph);
    return result.fileCheck.inventory;
  };
  const dispatch = (partitionPlan, options, context) =>
    runNodeCheckPartitions(plan, { cwd, log, ...context }, partitionPlan, options);

  const inventory = await discover();
  assert.deepEqual(inventory.files, [...files, bad]);
  const selected = await planNodeCheckPartitions(inventory, selection, { partitions: 2 });
  const full = await planNodeCheckPartitions(
    inventory,
    { ...base, mode: "full" },
    { partitions: 2 }
  );

  const dry = await dispatch(selected, { dryRun: true });
  assert.equal(dry.partitionCheck.outcome, "not-run");
  assert.deepEqual(dry.commands, []);
  assert.deepEqual(dry.partitionCheck.evidence, []);
  await assert.rejects(readFile(graph), { code: "ENOENT" });

  const subset = await dispatch(selected);
  assert.equal(subset.partitionCheck.outcome, "subset-passed", JSON.stringify(subset.run.errors));
  assert.equal(subset.partitionCheck.coverageComplete, true);
  assert.equal(
    subset.partitionCheck.partitionPlanDigest,
    await digestNodeCheckPartitionPlan(selected)
  );
  assert.equal(
    await verifyNodeCheckPartitionCoverage(selected, subset.partitionCheck.evidence),
    true
  );
  assert.deepEqual(
    subset.commands.map(({ id }) => id),
    ["install", "types", "after"]
  );
  assert.deepEqual(
    subset.partitionCheck.evidence.map(({ execution }) => execution.files.map(({ path }) => path)),
    files.map((file) => [file])
  );
  assert.equal(subset.partitionCheck.reports[0].result.report.truncated, true);
  assert.equal(await readFile(graph, "utf8"), "before\nsetup\nsetup\nafter\n");
  assert.equal(await readFile(executed, "utf8"), files.join("\n") + "\n");

  await rm(executed);
  await rm(graph);
  const failure = await dispatch(full);
  assert.equal(failure.partitionCheck.outcome, "failed");
  assert.equal(failure.partitionCheck.coverageComplete, false);
  assert.equal(failure.partitionCheck.evidence.length, 1);
  assert.equal(failure.partitionCheck.evidence[0].process.exitCode, 1);
  assert.ok(
    failure.partitionCheck.evidence[0].execution.files.some(
      ({ path, state }) => path === bad && state === "failed"
    )
  );
  assert.equal(await readFile(graph, "utf8"), "before\nsetup\n");

  await rm(executed);
  await rm(graph);
  await appendFile(config, "\n// Drift in the primary configuration.\n");
  const stale = await dispatch(selected);
  assert.equal(stale.partitionCheck.outcome, "failed");
  assert.match(stale.run.errors[0].message, /inventory changed/);
  assert.equal(stale.partitionCheck.evidence[0].execution, null);
  assert.notEqual(stale.partitionCheck.evidence[0].inventoryDigest, selected.inventoryDigest);
  assert.equal(await readFile(graph, "utf8"), "before\n");
  await assert.rejects(readFile(executed), { code: "ENOENT" });
  await writeFile(config, originalConfig);

  await rm(graph);
  await writeFile(
    setup,
    workingSetup
      .replace("import { appendFileSync }", "import { appendFileSync, writeFileSync }")
      .replace("project.provide", 'writeFileSync("spec/added.case.js", ""); project.provide')
  );
  const changedDuringRun = await dispatch(selected);
  assert.equal(changedDuringRun.partitionCheck.outcome, "failed");
  assert.equal(changedDuringRun.partitionCheck.coverageComplete, false);
  assert.equal(changedDuringRun.partitionCheck.evidence.length, 2);
  assert.equal(changedDuringRun.partitionCheck.evidence[0].execution.complete, true);
  assert.equal(changedDuringRun.partitionCheck.evidence[1].execution, null);
  assert.equal(await readFile(executed, "utf8"), files[0] + "\n");
  await rm(join(cwd, "spec/added.case.js"));
  await writeFile(setup, workingSetup);

  await writeFile(
    config,
    originalConfig.replace(
      'exclude: ["spec/excluded/**"]',
      `exclude: ["spec/excluded/**", "${bad}"]`
    )
  );
  const passing = await discover();
  const passingFull = await planNodeCheckPartitions(
    passing,
    { ...base, mode: "full" },
    { partitions: 2 }
  );
  const passingSelection = await planNodeCheckPartitions(passing, selection, { partitions: 2 });
  assert.equal((await dispatch(passingFull)).partitionCheck.outcome, "full-passed");
  assert.equal((await dispatch(passingSelection)).partitionCheck.outcome, "subset-passed");

  await writeFile(join(cwd, "fail-downstream"), "");
  const blocked = await dispatch(passingFull);
  assert.equal(blocked.partitionCheck.outcome, "failed");
  assert.equal(blocked.partitionCheck.coverageComplete, true);
  assert.equal(blocked.commands.at(-1).id, "after");
  await rm(join(cwd, "fail-downstream"));

  await writeFile(join(cwd, "app.js"), "export const answer = ;\n");
  const before = await dispatch(passingFull);
  assert.equal(before.partitionCheck.outcome, "failed");
  assert.equal(before.commands.at(-1).id, "types");
  assert.deepEqual(before.partitionCheck.evidence, []);
  await writeFile(join(cwd, "app.js"), "export const answer = 42;\n");

  await appendFile(config, '\nconsole.log("partition-config-ready");\n');
  const interruptedPlan = await planNodeCheckPartitions(await discover(), selection, {
    partitions: 2,
  });
  const controller = new AbortController();
  const stopped = await dispatch(interruptedPlan, undefined, {
    signal: controller.signal,
    log: {
      ...log,
      log(text) {
        if (String(text).includes("partition-config-ready")) controller.abort();
      },
    },
  });
  assert.equal(stopped.partitionCheck.outcome, "cancelled");
  assert.equal(stopped.partitionCheck.coverageComplete, false);
  assert.equal(stopped.partitionCheck.evidence.length, 1);
  assert.equal(stopped.partitionCheck.evidence[0].process.status, "cancelled");
  assert.ok(!stopped.commands.some(({ id }) => id === "after"));

  process.stdout.write(
    "Verified packed Vitest partition planning, exact local execution, DAG checks, and coverage.\n"
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
