import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

function launch(mode: string, boundary: string, directory: string) {
  const child = fork(
    fileURLToPath(new URL("./execution-journal-process.test-support.ts", import.meta.url)),
    [mode, boundary, directory],
    { silent: true, execArgv: ["--disable-warning=ExperimentalWarning"] }
  );
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 || signal === "SIGKILL" ? resolve() : reject(new Error(stderr))
    );
  });
  const message = new Promise<{
    ready?: boolean;
    runId: string;
    status?: string;
    sourceCode?: string;
  }>((resolve, reject) => {
    child.once("message", resolve);
    exited.then(() => reject(new Error(`Child exited before reporting: ${stderr}`)), reject);
  });
  return { child, message, exited };
}

it.each(["effect", "input"])(
  "recovers retained journal bytes after SIGKILL at an incomplete %s boundary",
  async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-journal-process-"));
    const children: ReturnType<typeof launch>[] = [];
    try {
      const first = launch("crash", boundary, directory);
      children.push(first);
      const before = await first.message;
      expect(before.ready).toBe(true);
      first.child.kill("SIGKILL");
      await first.exited;
      for (let attempt = 0; attempt < 2; attempt++) {
        const resumed = launch("resume", boundary, directory);
        children.push(resumed);
        const after = await resumed.message;
        await resumed.exited;
        expect(after.runId).not.toBe(before.runId);
        expect(after.status).toBe(boundary === "effect" ? "failed" : "completed");
        if (boundary === "effect")
          expect(after.sourceCode).toBe("TUBELESS_JOURNAL_OUTCOME_UNKNOWN");
      }
      expect(await readFile(join(directory, "effects"), "utf8")).toBe(
        boundary === "effect" ? "first\nuncertain\n" : "first\nlast\n"
      );
    } finally {
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.allSettled(children.map(({ exited }) => exited));
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000
);
