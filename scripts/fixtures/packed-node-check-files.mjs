import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(join(process.cwd(), "package.json"));
const { readNodeCheckPlan, runNodeCheck, runNodeCheckFiles } = await import(
  pathToFileURL(require.resolve("tubeless/node/check"))
);
const { digestNodeCheckFileRequest, digestNodeCheckFileInventory } = await import(
  pathToFileURL(require.resolve("tubeless/check-plan"))
);

const workspace = await mkdtemp(join(await realpath(tmpdir()), "tubeless-packed-file-check-"));
try {
  const cwd = join(workspace, "repository");
  await cp(new URL("./node-check/", import.meta.url), cwd, {
    recursive: true,
    filter: (path) => !path.endsWith("node_modules") && !path.endsWith(".tubeless-reports"),
  });
  await cp(new URL("./node-check-files/", import.meta.url), cwd, { recursive: true });
  const plan = await readNodeCheckPlan(cwd);
  const configFile = join(cwd, "vitest.config.js");
  const config = await readFile(configFile, "utf8");
  const ran = join(cwd, "executed.log");
  const configLoaded = join(cwd, "config-loaded.log");
  const log = { log() {}, warn() {}, error() {} };
  const invoke = (request, options) =>
    runNodeCheckFiles(plan, { cwd, log }, { version: 1, stepId: "test", ...request }, options);
  const inventory = { mode: "inventory" };
  const full = { mode: "full" };
  const selected = { mode: "selected", files: ["spec/check.case.js", "spec/archive.case.js"] };
  const expectedSelected = selected.files.toSorted();
  const expectedAll = [...expectedSelected, "spec/nested/spec/check.case.js"];

  await assert.rejects(readFile(configLoaded), { code: "ENOENT" });
  for (const files of [
    [],
    ["../outside.case.js"],
    ["/tmp/absolute.case.js"],
    ["spec\\check.case.js"],
    ["spec/check.case.js", "spec/CHECK.case.js"],
  ])
    await assert.rejects(invoke({ ...selected, files }), TypeError);
  await assert.rejects(invoke({ ...inventory, version: 2 }), /unsupported/);
  await assert.rejects(invoke({ ...inventory, stepId: "types" }), /No Vitest check/);
  const dry = await invoke(inventory, { dryRun: true });
  assert.equal(dry.fileCheck.inventory, null);
  assert.equal(dry.fileCheck.outcome, "not-run");
  assert.deepEqual(dry.commands, []);
  await assert.rejects(readFile(configLoaded), { code: "ENOENT" });

  const discovered = await invoke(inventory);
  assert.equal(discovered.run.status, "completed", JSON.stringify(discovered.run.errors));
  assert.deepEqual(
    discovered.commands.map(({ id }) => id),
    ["install", "types", "test"]
  );
  assert.deepEqual(discovered.fileCheck.inventory.files, expectedAll);
  assert.equal(discovered.fileCheck.inventory.complete, true);
  assert.equal(discovered.fileCheck.inventory.configuration.path, "vitest.config.js");
  assert.equal(discovered.fileCheck.inventory.source.commit, null);
  assert.equal(discovered.fileCheck.inventory.source.treeSha, null);
  assert.equal(discovered.fileCheck.inventory.toolchain.vitest, "5.1.0");
  assert.equal(discovered.fileCheck.execution, null);
  assert.equal(discovered.fileCheck.outcome, "inventory-complete");
  await assert.rejects(readFile(ran), { code: "ENOENT" });
  assert.equal(await readFile(configLoaded, "utf8"), "loaded\n");

  const listed = join(workspace, "vitest-list.json");
  execFileSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "list", "--filesOnly", `--json=${listed}`],
    { cwd }
  );
  assert.deepEqual(
    JSON.parse(await readFile(listed, "utf8"))
      .map(({ file }) => relative(cwd, file))
      .sort(),
    expectedAll
  );
  const repeated = await invoke(inventory);
  assert.deepEqual(repeated.fileCheck.inventory, discovered.fileCheck.inventory);
  assert.equal(repeated.fileCheck.inventoryDigest, discovered.fileCheck.inventoryDigest);

  const subset = await invoke(selected);
  assert.equal(subset.run.status, "completed", JSON.stringify(subset.run.errors));
  assert.deepEqual(
    subset.commands.map(({ id }) => id),
    ["install", "types", "test"]
  );
  assert.deepEqual(subset.fileCheck.request, {
    version: 1,
    stepId: "test",
    mode: "selected",
    files: expectedSelected,
  });
  assert.notEqual(subset.fileCheck.requestDigest, repeated.fileCheck.requestDigest);
  assert.equal(
    subset.fileCheck.requestDigest,
    await digestNodeCheckFileRequest(subset.fileCheck.planDigest, subset.fileCheck.request)
  );
  assert.equal(
    subset.fileCheck.inventoryDigest,
    await digestNodeCheckFileInventory(subset.fileCheck.inventory)
  );
  assert.equal(subset.fileCheck.inventoryDigest, discovered.fileCheck.inventoryDigest);
  assert.equal(subset.fileCheck.execution.complete, true);
  assert.equal(subset.fileCheck.outcome, "subset-passed");
  assert.deepEqual(
    subset.fileCheck.execution.files.map(({ path }) => path),
    expectedSelected
  );
  assert.ok(
    subset.fileCheck.execution.files.every(
      ({ state, durationMs }) => state === "passed" && durationMs >= 0 && durationMs !== null
    )
  );
  assert.deepEqual((await readFile(ran, "utf8")).trim().split("\n").sort(), expectedSelected);
  assert.equal(subset.reports[0].result.state, "available");
  assert.equal(subset.reports[0].result.report.truncated, true);

  await rm(ran);
  const unknown = await invoke({ ...selected, files: ["spec/unknown.case.js"] });
  assert.equal(unknown.run.status, "failed");
  assert.match(unknown.run.errors[0].message, /Unknown Vitest file/);
  assert.equal(unknown.fileCheck.execution, null);
  await assert.rejects(readFile(ran), { code: "ENOENT" });

  const all = await invoke(full);
  assert.equal(all.run.status, "failed");
  assert.equal(all.fileCheck.request.mode, "full");
  assert.equal(all.fileCheck.outcome, "failed");
  assert.notEqual(all.fileCheck.requestDigest, subset.fileCheck.requestDigest);
  assert.equal(all.fileCheck.execution.complete, true);
  assert.deepEqual(
    all.fileCheck.execution.files.map(({ path }) => path),
    expectedAll
  );
  assert.equal(all.fileCheck.execution.files.at(-1).state, "failed");
  assert.deepEqual((await readFile(ran, "utf8")).trim().split("\n").sort(), expectedAll);
  const legacy = await runNodeCheck(plan, { cwd, log });
  assert.equal(legacy.run.status, "failed");
  assert.equal(legacy.commands.at(-1).process.exitCode, 1);

  await writeFile(join(cwd, "app.js"), "export const broken = ;\n");
  await rm(configLoaded);
  const blocked = await invoke(selected);
  assert.equal(blocked.run.status, "failed");
  assert.equal(blocked.commands.at(-1).id, "types");
  assert.equal(blocked.fileCheck.inventory, null);
  await assert.rejects(readFile(configLoaded), { code: "ENOENT" });
  await writeFile(join(cwd, "app.js"), "export const answer = 42;\n");

  await writeFile(configFile, "process.exit(0);\n");
  const missing = await invoke(full);
  assert.equal(missing.commands.at(-1).process.exitCode, 0);
  assert.equal(missing.run.status, "failed");
  assert.equal(missing.fileCheck.outcome, "failed");
  assert.match(missing.run.errors[0].message, /evidence is missing/);

  await writeFile(
    configFile,
    `
    import { BaseSequencer } from "vitest/node";
    class FirstOnly extends BaseSequencer {
      async sort(files) { return (await super.sort(files)).slice(0, 1); }
    }
    export default { test: {
      include: ["spec/*.case.js"], globalSetup: "./global-setup.js", setupFiles: ["./setup.js"],
      sequence: { sequencer: FirstOnly },
    } };
  `
  );
  const unsupported = await invoke(inventory);
  assert.equal(unsupported.run.status, "failed");
  assert.match(unsupported.run.errors[0].message, /Unsupported Vitest configuration/);
  assert.equal(unsupported.fileCheck.inventory, null);

  const setup = 'globalSetup: "./global-setup.js", setupFiles: ["./setup.js"]';
  await writeFile(
    configFile,
    `
    export default { test: {
      include: ["spec/**/check.case.js"], ${setup},
      cache: false, bail: 1, fileParallelism: false,
    } };
  `
  );
  const partial = await invoke(full);
  assert.equal(partial.fileCheck.outcome, "failed");
  assert.equal(partial.fileCheck.execution.complete, false);
  assert.equal(partial.fileCheck.execution.files.length, 1);

  await writeFile(
    configFile,
    `export default { test: { include: ["spec/*.case.js"], ${setup} } };\n`
  );
  const fullPass = await invoke(full);
  assert.equal(fullPass.fileCheck.outcome, "full-passed");
  assert.equal(fullPass.fileCheck.execution.complete, true);
  assert.ok(fullPass.reports[0].result.report.truncated);

  await writeFile(
    configFile,
    'export default { test: { include: ["unmatched/**/*.case.js"], passWithNoTests: true } };\n'
  );
  const emptyInventory = await invoke(inventory);
  assert.equal(emptyInventory.run.status, "completed");
  assert.deepEqual(emptyInventory.fileCheck.inventory.files, []);
  const emptyFull = await invoke(full);
  assert.equal(emptyFull.run.status, "failed");
  assert.match(emptyFull.run.errors[0].message, /no runnable files/);

  await writeFile(configFile, config);
  const alias = join(cwd, "spec/alias.case.js");
  await symlink("check.case.js", alias);
  const symlinked = await invoke(inventory);
  assert.equal(symlinked.run.status, "failed");
  assert.match(symlinked.run.errors[0].message, /without symlinks/);
  assert.equal(symlinked.fileCheck.inventory, null);
  await rm(alias);

  await mkdir(join(workspace, "outside"));
  await writeFile(join(workspace, "outside/external.case.js"), "");
  await writeFile(
    configFile,
    'export default { test: { dir: "../outside", include: ["*.case.js"] } };\n'
  );
  const outside = await invoke(inventory);
  assert.equal(outside.run.status, "failed");
  assert.match(outside.run.errors[0].message, /out-of-root/);
  assert.equal(outside.fileCheck.inventory, null);

  await mkdir(join(cwd, "many"));
  for (let index = 0; index < 4097; index++)
    await writeFile(join(cwd, "many", `${index}.case.js`), "");
  await writeFile(configFile, 'export default { test: { include: ["many/*.case.js"] } };\n');
  const oversized = await invoke(inventory);
  assert.equal(oversized.run.status, "failed");
  assert.match(oversized.run.errors[0].message, /exceeds 4096 files/);
  assert.equal(oversized.fileCheck.inventory, null);

  process.stdout.write(
    "Verified packed Node check file discovery, exact selection, setup, and failure evidence with Vitest 5.1.0.\n"
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
