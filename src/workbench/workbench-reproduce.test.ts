import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  digestNodeCheckPlan,
  parseReproductionManifest,
  type ReproductionManifest,
} from "../utilities/reproduction-manifest.js";
import { runWorkbenchCli, TUBELESS_WORKBENCH_EXIT_CODE as exit } from "./workbench.js";
import { shellWord } from "./workbench-shared.js";
import { captureIo } from "./workbench.test-support.js";

const pinned = new URL("../../fixtures/reproduction/node-check-failure-v1.json", import.meta.url);
const source = new URL("../../scripts/fixtures/node-check/", import.meta.url);
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "tubeless-reproduce-test-"));
  roots.push(root);
  return root;
}

async function invoke(cwd: string, ...args: string[]) {
  const io = captureIo(cwd);
  const code = await runWorkbenchCli(["cloud", "reproduce", ...args], io);
  return { code, stdout: io.output.join(""), stderr: io.errors.join("") };
}

it("requires explicit execution and rejects oversized files without starting tools", async () => {
  const cwd = temporaryRoot();
  vi.stubEnv("PATH", "");
  expect(await invoke(cwd, "missing.json")).toMatchObject({
    code: exit.usage,
    stderr: expect.stringContaining("Pass --execute"),
    stdout: "",
  });
  writeFileSync(join(cwd, "manifest.json"), " ".repeat(65_537));
  expect(await invoke(cwd, "--execute", "manifest.json")).toMatchObject({
    code: exit.validation,
    stderr: expect.stringContaining("exceeds 64 KiB"),
    stdout: "",
  });
  if (process.platform !== "win32") {
    copyFileSync(pinned, join(cwd, "manifest.json"));
    expect(await invoke(cwd, "--execute", "manifest.json")).toMatchObject({
      code: exit.validation,
      stderr: expect.stringContaining("requires Node 24 on PATH"),
      stdout: "",
    });
  }
});

it.runIf(process.platform !== "win32" && process.versions.node.startsWith("24."))(
  "reproduces the pinned failure from a real Git fetch while preserving dirty files and isolating child environments",
  async () => {
    const manifest = await parseReproductionManifest(readFileSync(pinned));
    const requiredBun = manifest.nodeCheck.plan.toolchain.bun;
    const root = temporaryRoot();
    const cwd = join(root, "repository");
    const bin = join(root, "bin");
    const scratch = join(cwd, "scratch");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(bin);
    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bunPath = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Tubeless Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Tubeless Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const git = (...args: string[]) =>
      execFileSync(gitPath, args, { cwd, env, encoding: "utf8" }).trim();
    const files = ["app.js", "app.test.js", "bun.lock", "package.json", "tubeless.check.json"];
    for (const file of files) copyFileSync(new URL(file, source), join(cwd, file));
    writeFileSync(join(cwd, "app.js"), "export const answer = 41;\n");
    git("init", "--quiet", "--template=", "--object-format=sha1", "--initial-branch=main");
    git("add", "--", ...files);
    git("commit", "--quiet", "-m", "Fail the portable check fixture");
    expect(git("rev-parse", "HEAD")).toBe(manifest.source.commit);
    expect(git("rev-parse", "HEAD^{tree}")).toBe(manifest.source.treeSha);
    git("config", "uploadpack.allowReachableSHA1InWant", "true");
    copyFileSync(new URL("app.js", source), join(cwd, "app.js"));
    git("commit", "--quiet", "-am", "Move main to a passing revision");
    writeFileSync(join(cwd, "app.js"), "dirty tracked file\n");
    writeFileSync(join(cwd, "untracked.txt"), "untracked file\n");

    const fetchLog = join(root, "fetch.log");
    const bunProbes = join(root, "bun-probes.log");
    const marker = randomUUID();
    const isolated =
      'test -z "${TUBELESS_TOKEN}${CF_ACCESS_CLIENT_SECRET}${CLOUDFLARE_API_TOKEN}${NODE_OPTIONS}" || exit 19';
    const shim = (name: string, script: string) =>
      writeFileSync(join(bin, name), `#!/bin/sh\n${isolated}\n${script}\n`, { mode: 0o700 });
    const remote = `https://github.com/${manifest.repository.fullName}.git`;
    const fixtureRemote = shellWord(`url.file://${cwd}.insteadOf=${remote}`);
    shim(
      "git",
      `case " $* " in
  *" fetch "*)
    printf '%s\\n' "$@" >> ${shellWord(fetchLog)}
    export GIT_ALLOW_PROTOCOL=file
    exec ${shellWord(gitPath)} -c ${fixtureRemote} "$@"
    ;;
  *) printf '%s\\n' 'Fixture Git warning' >&2; exec ${shellWord(gitPath)} "$@" ;;
esac`
    );
    // Control just the version probe. Install and checks still use the installed Bun.
    const shimBun = (version: string) =>
      shim(
        "bun",
        `case "$1" in
  --version)
    printf '%s\\n' 'Fixture tool warning' >&2
    printf '%s\\n' probe >> ${shellWord(bunProbes)}
    printf '%s\\n' ${shellWord(version)}
    exit 0
    ;;
  install) test ! -e .git && ! git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 18 ;;
esac
exec ${shellWord(bunPath)} "$@"`
      );
    shimBun(requiredBun);
    shim("node", `exec ${shellWord(process.execPath)} "$@"`);
    vi.stubEnv("PATH", [bin, process.env.PATH].join(delimiter));
    vi.stubEnv("TMPDIR", scratch);
    vi.stubEnv("TUBELESS_TOKEN", marker);
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", marker);
    vi.stubEnv("CLOUDFLARE_API_TOKEN", marker);
    vi.stubEnv("NODE_OPTIONS", marker);

    const path = join(root, "manifest.json");
    const run = async (input: ReproductionManifest) => {
      writeFileSync(path, JSON.stringify(input));
      const output = await invoke(cwd, "--execute", path);
      expect(output.stderr + output.stdout).not.toContain(marker);
      return output;
    };
    const dirtyStatus = git("status", "--short");
    const output = await run(manifest);
    expect(output.stderr, output.stdout).toBe("");
    expect(output.code, output.stdout).toBe(exit.execution);
    const reproduced = JSON.parse(output.stdout);
    expect(reproduced).toMatchObject({
      original: { source: manifest.source, runtime: manifest.runtime },
      local: { node: process.versions.node, bun: requiredBun },
      differences:
        manifest.runtime.node === process.versions.node
          ? []
          : [{ tool: "node", recorded: manifest.runtime.node, local: process.versions.node }],
      execution: {
        run: { status: "failed" },
        reports: [
          {
            stepId: "test",
            result: {
              state: "available",
              report: {
                completeness: "complete",
                process: { exitCode: 1 },
                tests: [
                  {
                    title: "returns the expected answer",
                    file: "app.test.js",
                    line: 3,
                    outcome: "failed",
                    failures: [{ message: expect.stringContaining("expected 41 to be 42") }],
                  },
                ],
              },
            },
          },
        ],
      },
    });
    expect(
      reproduced.execution.commands.filter(({ id }: { id: string }) => id === "test")
    ).toHaveLength(1);
    expect(readFileSync(bunProbes, "utf8")).toBe("probe\n");
    expect(readFileSync(fetchLog, "utf8").trim().split("\n").slice(-2)).toEqual([
      remote,
      manifest.source.commit,
    ]);
    expect(git("status", "--short")).toBe(dirtyStatus);
    expect(readFileSync(join(cwd, "app.js"), "utf8")).toBe("dirty tracked file\n");
    expect(readFileSync(join(cwd, "untracked.txt"), "utf8")).toBe("untracked file\n");
    expect(git("rev-parse", "HEAD")).not.toBe(manifest.source.commit);

    const invalid = [
      [
        "does not match the recorded tree SHA",
        (input: ReproductionManifest) => {
          input.source.treeSha = "0".repeat(40);
        },
      ],
      [
        "does not match the recorded lockfile digest",
        (input: ReproductionManifest) => {
          input.source.lockfile.digest = "A".repeat(43);
        },
      ],
      [
        "does not match the recorded plan digest",
        async (input: ReproductionManifest) => {
          input.nodeCheck.plan.maxConcurrency = 2;
          input.nodeCheck.digest = await digestNodeCheckPlan(input.nodeCheck.plan);
        },
      ],
      [
        "Cannot fetch recorded commit",
        (input: ReproductionManifest) => {
          input.source.commit = "0".repeat(40);
        },
      ],
    ] as const;
    for (const [message, mutate] of invalid) {
      const input = structuredClone(manifest);
      await mutate(input);
      expect(await run(input), message).toMatchObject({
        code: exit.validation,
        stdout: "",
        stderr: expect.stringContaining(message),
      });
    }

    const fetches = readFileSync(fetchLog, "utf8");
    const [major, minor, patch] = requiredBun.split(".");
    const wrongBun = `${major}.${minor}.${Number(patch) + 1}`;
    shimBun(wrongBun);
    expect(await run(manifest)).toMatchObject({
      code: exit.validation,
      stdout: "",
      stderr: expect.stringContaining(`requires Bun ${requiredBun} on PATH. Found ${wrongBun}.`),
    });
    expect(readFileSync(fetchLog, "utf8")).toBe(fetches);
  },
  60_000
);
