import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileAsync, writeModule } from "./workbench.test-support.js";
import {
  MINIMUM_BUN_VERSION,
  missingBunMessage,
  outdatedBunMessage,
  versionAtLeast,
} from "./workbench-runtime.js";

const launcher = "dist/workbench/workbench-launcher.js";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
);

/** A directory with nothing in it, used as the whole `PATH` to hide every executable. */
function emptyPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "tubeless-empty-path-"));
  directories.push(directory);
  return directory;
}

describe("tubeless CLI launcher", () => {
  it.each(["node", "bun"])("starts the workbench on %s", async (runtime) => {
    const { stdout, stderr } = await execFileAsync(runtime, [launcher, "--help"], {
      cwd: process.cwd(),
    });
    expect(stdout).toContain("Usage: tubeless <command>");
    expect(stderr).toBe("");
  });

  it("prints the missing-Bun message when Node.js cannot find Bun", () => {
    // vitest itself runs on Node.js, so process.execPath is a Node binary that
    // ignores the shims on PATH and sees exactly the directories this test sets.
    const { status, stdout, stderr } = spawnSync(process.execPath, [launcher, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPath() },
    });
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(missingBunMessage());
  });

  it("passes the environment through the Node.js handoff", () => {
    // Node 22.18 ignores the documented `env` default of process.execve and
    // passes an empty environment, which would strand TUBELESS_TOKEN, HOME and PATH.
    const directory = emptyPath();
    const fakeBun = join(directory, "bun");
    writeFileSync(fakeBun, '#!/bin/sh\nprintf "%s" "$TUBELESS_LAUNCHER_ENV_MARKER"\n', {
      mode: 0o755,
    });
    const { status, stdout } = spawnSync(process.execPath, [launcher, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: directory, TUBELESS_LAUNCHER_ENV_MARKER: "visible" },
    });
    expect(status).toBe(0);
    expect(stdout).toBe("visible");
  });

  it("reports the same failure as the direct entry for a missing file", () => {
    const args = ["inspect", "./does-not-exist.ts"];
    const direct = spawnSync("bun", ["dist/workbench/workbench-bin.js", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const through = spawnSync("node", [launcher, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(through.status).toBe(direct.status);
    expect(through.status).not.toBe(0);
    expect(through.stderr).toBe(direct.stderr);
  });

  it("replaces the Node.js process with Bun so SIGTERM reaches the workbench", async () => {
    const { filePath } = await writeModule(`
      export default async ({ signal }) => {
        console.error("setup-started");
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30000);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        throw new Error("cancelled setup must not complete");
      };
    `);
    const child = spawn(
      "node",
      [launcher, "agent", "--model-module", filePath, "--prompt", "task", "--no-graph"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout.resume();
    let stderr = "";
    let closed = false;
    const completed = new Promise<number | null>((resolve) =>
      child.on("close", (code) => {
        closed = true;
        resolve(code);
      })
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const testRun = async () => {
        await new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
            if (stderr.includes("setup-started")) resolve();
          });
        });
        child.kill("SIGTERM");
        return completed;
      };
      const code = await Promise.race([
        testRun(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Launcher cancellation did not finish")),
            2000
          );
        }),
      ]);
      expect(code).toBe(7);
      expect(stderr).toContain("Cancelled");
    } finally {
      clearTimeout(timeout);
      if (!closed) child.kill("SIGKILL");
      await completed;
    }
  });

  it("compares versions for the Bun minimum", () => {
    expect(versionAtLeast("22.12.0", "22.12.0")).toBe(true);
    expect(versionAtLeast("v24.1.0", "22.12.0")).toBe(true);
    expect(versionAtLeast("22.11.9", "22.12.0")).toBe(false);
    expect(versionAtLeast("22.6.0", "22.12.0")).toBe(false);
    expect(versionAtLeast("23.0.0-pre", "22.12.0")).toBe(true);
  });

  it("pins the launcher minimum to engines.bun", () => {
    const { engines } = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines: { bun: string };
    };
    expect(engines.bun).toBe(`>=${MINIMUM_BUN_VERSION}`);
  });

  it("names the found and required versions when Bun is outdated", () => {
    expect(outdatedBunMessage("1.2.0")).toContain("1.2.0");
    expect(outdatedBunMessage("1.2.0")).toContain(MINIMUM_BUN_VERSION);
  });
});
