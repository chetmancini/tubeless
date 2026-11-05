import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRunInput, CloudRunUsageError, type CloudRunInputArguments } from "./run-input.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
async function context() {
  const cwd = await mkdtemp(join(tmpdir(), "tubeless-run-input-"));
  directories.push(cwd);
  return { cwd, signal: new AbortController().signal };
}
const main = { kind: "main", commit: "a".repeat(40) } as const;
const pr = {
  kind: "pull_request",
  number: 19,
  headSha: "b".repeat(40),
  baseSha: "c".repeat(40),
  mergeSha: "d".repeat(40),
} as const;

describe("Cloud run input preparation", () => {
  it("defaults to empty input without selecting source and gives new work a fresh key", async () => {
    const io = await context();
    const first = await prepareRunInput({}, io);
    const second = await prepareRunInput({}, io);
    expect(first.input).toEqual({});
    expect(first.source).toBeUndefined();
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it.each([main, pr])("reads inline $kind source with input from stdin", async (source) => {
    const readStdin = vi.fn(async () => '{"n":42}');
    expect(
      await prepareRunInput(
        { source: JSON.stringify(source), "input-file": "-", "idempotency-key": "ci.fixed" },
        { ...(await context()), readStdin }
      )
    ).toEqual({ input: { n: 42 }, source, idempotencyKey: "ci.fixed" });
    expect(readStdin).toHaveBeenCalledTimes(1);
  });

  it.each(["feature/orders", "tags/v1.2.3", "abc1234"])(
    "prepares --ref %s without changing case or intent",
    async (ref) => {
      expect((await prepareRunInput({ ref }, await context())).source).toEqual({
        kind: "ref",
        ref,
      });
    }
  );

  it("requires @ for files and reads @- as a file while stdin supplies input", async () => {
    const io = await context();
    await writeFile(join(io.cwd, "source.json"), JSON.stringify(main));
    await writeFile(join(io.cwd, "-"), JSON.stringify(pr));
    expect((await prepareRunInput({ source: "@source.json" }, io)).source).toEqual(main);
    await expect(prepareRunInput({ source: "source.json" }, io)).rejects.toMatchObject({
      code: "invalid_request",
    });
    const readStdin = vi.fn(async () => '{"n":42}');
    const result = await prepareRunInput({ source: "@-", "input-file": "-" }, { ...io, readStdin });
    expect(result).toMatchObject({ input: { n: 42 }, source: pr });
    expect(readStdin).toHaveBeenCalledTimes(1);
  });

  it("reads source from stdin and domain input from a file", async () => {
    const io = await context();
    await writeFile(join(io.cwd, "input.json"), '{"n":42}');
    expect(
      await prepareRunInput(
        { source: "-", "input-file": "input.json", "idempotency-key": "same-key" },
        { ...io, readStdin: async () => JSON.stringify(main) }
      )
    ).toEqual({ input: { n: 42 }, source: main, idempotencyKey: "same-key" });
  });

  it.each<CloudRunInputArguments>([
    { "input-file": "" },
    { source: "" },
    { source: "@" },
    { ref: "" },
    { ref: "main", source: JSON.stringify(main) },
    { source: "-", "input-file": "-" },
  ])("rejects invalid combinations before reading input: %j", async (args) => {
    const readStdin = vi.fn();
    await expect(prepareRunInput(args, { ...(await context()), readStdin })).rejects.toBeInstanceOf(
      CloudRunUsageError
    );
    expect(readStdin).not.toHaveBeenCalled();
  });

  it.each(["", "key with spaces", "a".repeat(201), "bad\nkey", "trailing\n", "trailing\r"])(
    "rejects an invalid caller key before reading source: %j",
    async (key) => {
      const readStdin = vi.fn();
      await expect(
        prepareRunInput(
          { source: "-", "idempotency-key": key },
          { ...(await context()), readStdin }
        )
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(readStdin).not.toHaveBeenCalled();
    }
  );

  it.each(["../main", "main\n", "é".repeat(513), "bad\ud800"])(
    "rejects invalid refs: %j",
    async (ref) => {
      await expect(prepareRunInput({ ref }, await context())).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
  );

  it.each(["inline", "file", "stdin"] as const)(
    "rejects invalid source JSON from %s",
    async (mode) => {
      const io = await context();
      for (const text of [
        "null",
        "[]",
        "{",
        '{"kind":"main","commit":"short"}',
        JSON.stringify({ ...main, repository: "other" }),
        JSON.stringify({ ...main, padding: "x".repeat(65536) }),
      ]) {
        await writeFile(join(io.cwd, "source.json"), text);
        const source = mode === "inline" ? text : mode === "file" ? "@source.json" : "-";
        await expect(
          prepareRunInput({ source }, { ...io, readStdin: async () => text })
        ).rejects.toMatchObject({ code: "invalid_request" });
      }
    }
  );

  it.each(["file", "stdin"] as const)(
    "rejects invalid/oversized domain input from %s",
    async (mode) => {
      const io = await context();
      for (const text of [
        "null",
        "[]",
        "{",
        '"scalar"',
        JSON.stringify({ long: "x".repeat(65536) }),
        '{"threshold":1e400}',
        '{"nested":[{"threshold":-1e400}]}',
        '{"a":'.repeat(129) + "1" + "}".repeat(129),
      ]) {
        await writeFile(join(io.cwd, "input.json"), text);
        await expect(
          prepareRunInput(
            { "input-file": mode === "file" ? "input.json" : "-" },
            { ...io, readStdin: async () => text }
          )
        ).rejects.toMatchObject({ code: "invalid_request" });
      }
    }
  );

  it("interrupts a pending stdin read", async () => {
    const io = await context();
    const controller = new AbortController();
    const readStdin = vi.fn(() => new Promise<string>(() => {}));
    const prepared = prepareRunInput(
      { "input-file": "-" },
      { ...io, signal: controller.signal, readStdin }
    );
    expect(readStdin).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(prepared).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects FIFO input without waiting for a writer",
    async () => {
      const io = await context();
      await promisify(execFile)("mkfifo", [join(io.cwd, "input.json")]);
      await expect(prepareRunInput({ "input-file": "input.json" }, io)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
  );
});
