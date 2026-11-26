import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Reporter, TestSpecification } from "vitest/node";
import {
  digestNodeCheckFileInventory,
  isNodeCheckFilePath,
  NODE_CHECK_FILE_LIMITS,
  normalizeNodeCheckFiles,
  type NodeCheckFileCompletion,
} from "../utilities/node-check/files.js";
import type { VitestFileInput, VitestFileObservation } from "./vitest-files.js";

const nodePools = new Set(["forks", "threads", "vmForks", "vmThreads"]);

function repositoryPath(root: string, file: string): string {
  const path = relative(root, file);
  if (!isAbsolute(file) || !isNodeCheckFilePath(path))
    throw new TypeError("Vitest discovered an invalid or out-of-root file path.");
  return path;
}

async function requireRegularFile(root: string, path: string): Promise<void> {
  const file = resolve(root, path);
  if ((await realpath(file)) !== file || !(await lstat(file)).isFile())
    throw new TypeError(`Vitest file must be a regular file without symlinks: ${path}.`);
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64url");
}

async function run(transport: string, observed: VitestFileObservation): Promise<void> {
  const root = await realpath(process.cwd());
  const input = JSON.parse(
    await readFile(join(transport, "input.json"), "utf8")
  ) as VitestFileInput;
  const { request, argv, version } = input;
  // Resolve the same package as the recipe's relative CLI entry point.
  const cli = await realpath(resolve(root, argv[1]));
  const require = createRequire(cli);
  const entry = require.resolve("vitest/node");
  const vitest = (await import(pathToFileURL(entry).href)) as typeof import("vitest/node");
  if (vitest.version !== version)
    throw new Error(`Vitest file execution requires ${version}; found ${vitest.version}.`);

  const { options } = vitest.parseCLI(["vitest", ...argv.slice(2)]);
  // The CLI's singular alias overrides programmatic reporters if both are present.
  delete options.reporter;
  process.env.TEST = "true";
  process.env.VITEST = "true";
  process.env.NODE_ENV ??= "test";

  const completed: NodeCheckFileCompletion[] = [];

  const reporter: Reporter = {
    onTestModuleEnd(module) {
      const state = module.state();
      if (state === "pending" || state === "queued") return;
      if (completed.length >= NODE_CHECK_FILE_LIMITS.files)
        throw new Error("Vitest file completion limit exceeded.");
      let ran = false;
      for (const test of module.children.allTests()) {
        const state = test.result().state;
        if (state === "passed" || state === "failed") {
          ran = true;
          break;
        }
      }
      const duration = module.diagnostic().duration;
      completed.push({
        path: relative(root, module.moduleId),
        state: state === "failed" ? "failed" : ran ? "passed" : "skipped",
        durationMs: ran && Number.isFinite(duration) && duration >= 0 ? duration : null,
      });
    },
    onTestRunEnd(modules, errors, reason) {
      const paths = new Set(modules.map(({ moduleId }) => relative(root, moduleId)));
      observed.execution = {
        files: completed,
        complete:
          reason !== "interrupted" &&
          modules.length === completed.length &&
          paths.size === completed.length &&
          completed.every(({ path }) => paths.has(path)),
      };
      // Vitest permits ignoring unhandled errors via config. They cannot establish verified success.
      if (errors.length || reason !== "passed") process.exitCode = 1;
    },
  };
  const ctx = await vitest.createVitest({
    ...options,
    watch: false,
    run: true,
    reporters: request.mode === "inventory" ? [] : ["json", reporter],
    outputFile: resolve(root, input.reportPath),
  });
  try {
    // These modes either bypass normal discovery, or can omit specs after discovery.
    const config = ctx.config;
    if (
      config.shard ||
      config.changed ||
      config.related ||
      config.cliOptions.lastFailed ||
      config.experimental.preParse ||
      config.mergeReports ||
      config.standalone ||
      config.clearCache ||
      config.listTags ||
      config.sequence.sequencer !== vitest.BaseSequencer ||
      ctx.projects.some(
        ({ config }) =>
          config.typecheck.enabled ||
          config.browser?.enabled ||
          config.runner ||
          typeof config.pool !== "string" ||
          !nodePools.has(config.pool)
      )
    )
      throw new TypeError(
        "Unsupported Vitest configuration for portable file inventory and execution."
      );

    if (input.expectedInventoryDigest && config.coverage.enabled)
      throw new TypeError("Vitest coverage collection is unsupported for partitioned checks.");

    const specs = await ctx.getRelevantTestSpecifications();
    if (specs.length > NODE_CHECK_FILE_LIMITS.files)
      throw new TypeError("Vitest file list exceeds 4096 files.");
    const byPath = new Map<string, TestSpecification>();
    const files = normalizeNodeCheckFiles(
      specs.map((spec) => {
        const path = repositoryPath(root, spec.moduleId);
        byPath.set(path, spec);
        return path;
      })
    );
    for (const path of files) await requireRegularFile(root, path);
    const configFile = ctx.vite.config.configFile;
    const configPath = configFile ? repositoryPath(root, configFile) : null;
    if (configPath) await requireRegularFile(root, configPath);
    observed.inventory = {
      version: 1,
      complete: true,
      files,
      stepId: request.stepId,
      planDigest: input.planDigest,
      source: {
        commit: null,
        treeSha: null,
        lockfileDigest: await fileDigest(join(root, "bun.lock")),
      },
      toolchain: {
        node: process.versions.node,
        bun: input.bun,
        vitest: vitest.version,
        platform: process.platform,
        arch: process.arch,
      },
      configuration: configPath
        ? { path: configPath, digest: await fileDigest(resolve(root, configPath)) }
        : null,
    };
    if (
      input.expectedInventoryDigest &&
      (await digestNodeCheckFileInventory(observed.inventory)) !== input.expectedInventoryDigest
    )
      throw new Error("Vitest inventory changed after partition planning.");
    if (request.mode === "inventory") return;

    const expected = request.mode === "selected" ? request.files : files;
    if (!expected.length) throw new Error("Vitest discovered no runnable files.");
    const selected = expected.map((path) => {
      const spec = byPath.get(path);
      if (!spec) throw new TypeError(`Unknown Vitest file: ${path}.`);
      return spec;
    });
    if (request.mode === "full") {
      await ctx.start();
    } else {
      // Initialize Vitest reporters and coverage before running the exact specs.
      await ctx.standalone();
      await ctx.runTestSpecifications(selected);
    }
  } finally {
    await ctx.close();
  }
}

const transport = process.argv[2];
const observed: VitestFileObservation = { inventory: null, execution: null, error: null };
try {
  await run(transport, observed);
} catch (error) {
  observed.error =
    error instanceof Error ? error.message.slice(0, 1024) : "Vitest file evaluation failed.";
  console.error(error);
  process.exitCode = 1;
}
await writeFile(join(transport, "result.json"), JSON.stringify(observed), { flag: "wx" });
