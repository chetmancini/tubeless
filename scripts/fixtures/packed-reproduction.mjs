import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The Cloud fixture can supply the manifest saved by the packaged download command.
const manifestPath =
  process.argv[3] ??
  new URL("../../fixtures/reproduction/node-check-failure-v1.json", import.meta.url);
const fixture = new URL("./node-check/", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { node: requiredNode, bun: requiredBun } = manifest.nodeCheck.plan.toolchain;
assert.equal(process.versions.node.split(".")[0], requiredNode, "Use the fixture's Node major");
assert.ok(process.argv[2], "Pass the installed tubeless executable");
const binary = resolve(process.argv[2]);
const shellWord = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const find = (name) => execFileSync("which", [name], { encoding: "utf8" }).trim();
const gitPath = find("git");
const bunPath = find("bun");
const actualBun = execFileSync(bunPath, ["--version"], { encoding: "utf8" }).trim();

const root = mkdtempSync(join(realpathSync(tmpdir()), "tubeless-packed-reproduction-"));
try {
  const cwd = join(root, "repository");
  const physicalTemp = join(root, "physical");
  const tempAlias = join(root, "symlinked-tmp");
  const bin = join(root, "bin");
  for (const dir of [cwd, physicalTemp, bin]) mkdirSync(dir);
  symlinkSync(physicalTemp, tempAlias, "dir");
  assert.equal(realpathSync(tempAlias), physicalTemp);
  assert.notEqual(tempAlias, physicalTemp);

  const gitEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Tubeless Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Tubeless Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const git = (...args) =>
    execFileSync(gitPath, args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
  const files = ["app.js", "app.test.js", "bun.lock", "package.json", "tubeless.check.json"];
  for (const file of files) copyFileSync(new URL(file, fixture), join(cwd, file));
  const app = join(cwd, "app.js");
  const untracked = join(cwd, "untracked.txt");
  writeFileSync(app, "export const answer = 41;\n");
  git("init", "--quiet", "--template=", "--object-format=sha1", "--initial-branch=main");
  git("add", "--", ...files);
  git("commit", "--quiet", "-m", "Fail the portable check fixture");
  assert.equal(git("rev-parse", "HEAD"), manifest.source.commit);
  assert.equal(git("rev-parse", "HEAD^{tree}"), manifest.source.treeSha);
  git("config", "uploadpack.allowReachableSHA1InWant", "true");
  copyFileSync(new URL("app.js", fixture), app);
  git("commit", "--quiet", "-am", "Move main to a passing revision");
  const head = git("rev-parse", "HEAD");
  writeFileSync(app, "dirty tracked file\n");
  writeFileSync(untracked, "untracked file\n");
  const status = git("status", "--short");

  // Redirect only the transport. The packaged CLI still fetches and checks out the pinned Git object.
  const remote = `https://github.com/${manifest.repository.fullName}.git`;
  const redirect = shellWord(`url.${pathToFileURL(cwd).href}.insteadOf=${remote}`);
  const shim = (name, body) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  shim(
    "git",
    `case " $* " in
  *" fetch "*) export GIT_ALLOW_PROTOCOL=file; exec ${shellWord(gitPath)} -c ${redirect} "$@" ;;
  *) exec ${shellWord(gitPath)} "$@" ;;
esac`
  );
  // The release lane has the exact Bun pin. Other local Bun versions can execute
  // the same locked fixture through a shim for the version probe alone.
  if (actualBun !== requiredBun)
    shim(
      "bun",
      `if [ "$1" = --version ]; then printf '%s\\n' ${shellWord(requiredBun)}; exit 0; fi
exec ${shellWord(bunPath)} "$@"`
    );

  const path = join(root, "manifest.json");
  copyFileSync(manifestPath, path);
  const output = spawnSync(binary, ["cloud", "reproduce", "--execute", path], {
    cwd,
    env: {
      ...process.env,
      PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
      TMPDIR: tempAlias,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.ifError(output.error);
  assert.equal(output.status, 6, output.stderr || output.stdout);
  assert.equal(output.stderr, "");
  assert.deepEqual(readdirSync(physicalTemp), [], "Remove the temporary checkout");
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("status", "--short"), status);
  assert.equal(readFileSync(app, "utf8"), "dirty tracked file\n");
  assert.equal(readFileSync(untracked, "utf8"), "untracked file\n");

  const { original, local, execution } = JSON.parse(output.stdout);
  assert.deepEqual(original.run, manifest.run);
  assert.deepEqual(original.source, manifest.source);
  assert.equal(local.bun, requiredBun);
  assert.equal(execution.run.status, "failed");
  assert.deepEqual(
    execution.commands.map(({ id, process }) => [id, process.status, process.exitCode]),
    [
      ["install", "exited", 0],
      ["types", "exited", 0],
      ["test", "exited", 1],
    ]
  );
  assert.equal(execution.reports.length, 1);
  const { stepId, result } = execution.reports[0];
  assert.equal(stepId, "test");
  assert.equal(result.state, "available");
  assert.equal(result.report.completeness, "complete");
  assert.equal(result.report.tests.length, 1);
  const { id, title, file, line, outcome, failures } = result.report.tests[0];
  assert.equal(id, JSON.stringify(["app.test.js", [], "returns the expected answer", 0]));
  assert.equal(title, "returns the expected answer");
  assert.equal(file, "app.test.js");
  assert.equal(line, 3);
  assert.equal(outcome, "failed");
  assert.equal(failures[0]?.file, file);
  assert.match(failures[0]?.message ?? "", /expected 41 to be 42/);
  process.stdout.write(
    `Verified tubeless@${local.tubeless} with Node ${local.node} and Bun ${actualBun}: ${file}:${line} ${title}.\n`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
