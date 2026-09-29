import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bashTool } from "./default-tool-bash.js";

const directories: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-bash-"));
  directories.push(cwd);
  return { cwd };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("default bash tool", () => {
  it("runs in cwd and reports stdout, stderr and nonzero exit codes", async () => {
    const context = await workspace();
    const result = await bashTool(
      { command: "printf hello; printf problem >&2; printf content > created; exit 7" },
      context
    );
    expect(result).toMatchObject({
      stdout: "hello",
      stderr: "problem",
      exitCode: 7,
      signal: null,
      timedOut: false,
      truncated: false,
    });
    expect(await readFile(join(context.cwd, "created"), "utf8")).toBe("content");
  });

  it("drains output while retaining at most 16 KiB across both streams", async () => {
    const result = await bashTool(
      { command: "printf err >&2; head -c 100000 /dev/zero | tr '\\0' x" },
      await workspace()
    );
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(16_384);
  });

  it("escalates a timeout and tolerates a cleanup race after the process group closes", async () => {
    const started = Date.now();
    const kill = process.kill.bind(process);
    let kills = 0;
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === "SIGKILL" && ++kills === 2)
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return kill(pid, signal);
    });
    try {
      const result = await bashTool(
        { command: "trap '' TERM; printf ready; sleep 30 & wait", timeoutMs: 1000 },
        await workspace()
      );
      expect(result.timedOut).toBe(true);
      expect(result.stdout).toBe("ready");
      expect(result.signal).toBe("SIGKILL");
      expect(kills).toBe(2);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      spy.mockRestore();
    }
  });

  it("drains the process on cancellation and preserves the original reason", async () => {
    const context = await workspace();
    const controller = new AbortController();
    const reason = new Error("cancel command");
    const command = bashTool(
      { command: "printf ready > ready; sleep 30 & wait" },
      { ...context, signal: controller.signal }
    );
    const outcome = command.catch((error: unknown) => error);
    try {
      await vi.waitFor(async () =>
        expect(await readFile(join(context.cwd, "ready"), "utf8")).toBe("ready")
      );
    } finally {
      controller.abort(reason);
    }
    expect(await outcome).toBe(reason);
  });

  it("does not spawn after cancellation and reports startup failures as observations", async () => {
    const context = await workspace();
    const signal = AbortSignal.abort(new Error("already stopped"));
    expect(() => bashTool({ command: "touch created" }, { ...context, signal })).toThrow(
      "already stopped"
    );
    await expect(readFile(join(context.cwd, "created"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(bashTool({ command: "true", cwd: "missing" }, context)).rejects.toMatchObject({
      code: "BASH_FAILED",
    });
    expect(() => bashTool({ command: "bad\u0000command" }, context)).toThrow(
      expect.objectContaining({ code: "BASH_FAILED" })
    );
  });
});
