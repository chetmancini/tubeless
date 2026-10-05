import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openSqliteAgentCheckpointStore } from "./node.js";

function launch(mode: string, directory: string) {
  const child = fork(
    fileURLToPath(new URL("./durability-process.test-support.ts", import.meta.url)),
    [
      mode,
      join(directory, "state.db"),
      join(directory, "effects"),
      join(directory, "decisions"),
      directory,
    ],
    { silent: true, execArgv: ["--disable-warning=ExperimentalWarning"] }
  );
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 || signal === "SIGKILL"
        ? resolve()
        : reject(new Error(`Child exited ${code}: ${stderr}`))
    );
  });
  const message = new Promise<{ ready?: boolean; result?: { answer: string } }>(
    (resolve, reject) => {
      child.once("message", resolve);
      exited.then(() => reject(new Error(`Child exited before its message: ${stderr}`)), reject);
    }
  );
  return { child, message, exited };
}

it("survives SIGKILL with committed model state, call receipts and budgets in a fresh Node process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-durable-process-"));
  const children: ChildProcess[] = [];
  try {
    const first = launch("crash", directory);
    children.push(first.child);
    expect(await first.message).toEqual({ ready: true });
    const competing = await openSqliteAgentCheckpointStore(join(directory, "state.db"));
    try {
      await expect(competing.acquire("job")).rejects.toMatchObject({
        code: "TUBELESS_AGENT_EXECUTION_BUSY",
      });
      const other = await competing.acquire("other-job");
      await other.write("independent");
      await other.close();
    } finally {
      competing.close();
    }
    first.child.kill("SIGKILL");
    await first.exited;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumed = launch("resume", directory);
      children.push(resumed.child);
      expect(await resumed.message).toEqual({
        result: { answer: "first|TUBELESS_AGENT_CALL_INTERRUPTED|last" },
      });
      await resumed.exited;
    }
    expect(await readFile(join(directory, "effects"), "utf8")).toBe("first\nuncertain\nlast\n");
    expect(await readFile(join(directory, "decisions"), "utf8")).toBe("1\n2\n");
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
