import { defer } from "../core/child-pipeline.test-support.js";
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editTool, listTool, readTool, searchTool, writeTool } from "./default-tool-files.js";

vi.mock("node:fs/promises", { spy: true });
const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
const directories: string[] = [];
// These tests exercise the string-name, withFileTypes overload.
const directoryReads = vi.mocked<
  (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>
>(fs.readdir);
async function workspace() {
  const cwd = await fs.mkdtemp(join(tmpdir(), "tubeless-tool-write-"));
  directories.push(cwd);
  await fs.writeFile(join(cwd, "target"), "original content", { mode: 0o751 });
  await fs.chmod(join(cwd, "target"), 0o771);
  return { cwd };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open);
  directoryReads.mockReset().mockImplementation(actualFs.readdir);
  await Promise.all(
    directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  );
});

describe("workspace file reads", () => {
  it.each([
    { text: "alpha\r\nbeta\r\n", startLine: 1, maxLines: 200, expected: "alpha\r\nbeta\r\n" },
    {
      text: "before\r\nalpha\r\nbeta\r\nafter",
      startLine: 2,
      maxLines: 2,
      expected: "alpha\r\nbeta",
    },
    {
      text: "before\nalpha\r\nbeta\ngamma\r\nafter",
      startLine: 2,
      maxLines: 3,
      expected: "alpha\r\nbeta\ngamma",
    },
    { text: "before\r\nalpha\r\nafter", startLine: 2, maxLines: 1, expected: "alpha" },
    { text: "before\nalpha\r", startLine: 2, maxLines: 1, expected: "alpha\r" },
  ])("preserves separators in an exact read-to-edit round trip ($text)", async (input) => {
    const context = await workspace();
    const path = join(context.cwd, "target");
    await fs.writeFile(path, input.text);
    const result = await readTool(
      { path, startLine: input.startLine, maxLines: input.maxLines },
      context
    );
    expect(result.content).toBe(input.expected);
    await editTool({ path, oldText: result.content, newText: "replacement" }, context);
    expect(await fs.readFile(path, "utf8")).toBe(input.text.replace(input.expected, "replacement"));
  });

  it.each([
    {
      name: "LF boundary",
      length: 16_383,
      separator: "\n",
      retainedSeparator: "\n",
      startLine: 1,
      next: "SECOND",
    },
    {
      name: "CRLF boundary",
      length: 16_382,
      separator: "\r\n",
      retainedSeparator: "\r\n",
      startLine: 2,
      next: "SECOND",
    },
    {
      name: "partial CRLF separator",
      length: 16_383,
      separator: "\r\n",
      retainedSeparator: "\r",
      startLine: 2,
      next: "SECOND",
    },
    {
      name: "partial UTF-8 character",
      length: 16_381,
      separator: "\n",
      retainedSeparator: "\n",
      startLine: 2,
      next: "🙂SECOND",
    },
  ])(
    "does not skip the next line after clipping at a $name",
    async ({ length, separator, retainedSeparator, startLine, next }) => {
      const context = await workspace();
      const first = "x".repeat(length);
      const prefix = startLine === 1 ? "" : `before${separator}`;
      await fs.writeFile(join(context.cwd, "target"), `${prefix}${first}${separator}${next}`);
      const result = await readTool({ path: "target", startLine }, context);
      expect(result).toMatchObject({
        content: `${first}${retainedSeparator}`,
        startLine,
        endLine: startLine,
        totalLines: startLine + 1,
        truncated: true,
      });
      expect(
        await readTool({ path: "target", startLine: result.endLine + 1 }, context)
      ).toMatchObject({
        content: next,
        startLine: startLine + 1,
        endLine: startLine + 1,
        truncated: false,
      });
    }
  );

  it.each(["\n", "\r\n"])("retains empty final lines with %j separators", async (separator) => {
    const context = await workspace();
    const text = `${"x".repeat(16_384 - separator.length)}${separator}`;
    await fs.writeFile(join(context.cwd, "target"), text);
    expect(await readTool({ path: "target" }, context)).toMatchObject({
      content: text,
      endLine: 2,
      totalLines: 2,
      truncated: false,
    });
    expect(await readTool({ path: "target", startLine: 2 }, context)).toMatchObject({
      content: "",
      endLine: 2,
      totalLines: 2,
      truncated: false,
    });
    await fs.writeFile(join(context.cwd, "target"), "");
    expect(await readTool({ path: "target" }, context)).toMatchObject({
      content: "",
      endLine: 0,
      totalLines: 0,
      truncated: false,
    });
  });
});

describe("workspace search and listing", () => {
  it("sorts directory entries before limiting a listing", async () => {
    const context = await workspace();
    const names = Array.from(
      { length: 205 },
      (_, index) => `file-${String(index).padStart(3, "0")}`
    );
    await Promise.all(
      names
        .slice()
        .reverse()
        .map((name) => fs.writeFile(join(context.cwd, name), ""))
    );
    const entries = await actualFs.readdir(context.cwd, { withFileTypes: true });
    directoryReads.mockResolvedValueOnce(entries.slice().reverse());
    const reversed = await listTool({}, context);
    directoryReads.mockResolvedValueOnce(entries);
    expect(await listTool({}, context)).toEqual(reversed);
    expect(reversed.entries.map(({ name }) => name)).toEqual(names.slice(0, 200));
    expect(reversed.truncated).toBe(true);
  });

  it("sorts directories before descending and applying search match limits", async () => {
    const context = await workspace();
    for (const name of ["z", "a"]) {
      await fs.mkdir(join(context.cwd, name));
      await fs.writeFile(join(context.cwd, name, "hits"), "needle\n".repeat(26));
    }
    const entries = await actualFs.readdir(context.cwd, { withFileTypes: true });
    directoryReads.mockResolvedValueOnce(entries.slice().reverse());
    const reversed = await searchTool({ query: "needle" }, context);
    directoryReads.mockResolvedValueOnce(entries);
    expect(await searchTool({ query: "needle" }, context)).toEqual(reversed);
    expect(reversed.matches.map(({ path }) => path)).toEqual([
      ...Array(26).fill(join(context.cwd, "a", "hits")),
      ...Array(24).fill(join(context.cwd, "z", "hits")),
    ]);
    expect(reversed.truncated).toBe(true);
  });

  it("bounds concurrent file reads and retains traversal order after out-of-order completion", async () => {
    const context = await workspace();
    const names = Array.from({ length: 9 }, (_, index) => `file-${index}`);
    await Promise.all(names.map((name) => fs.writeFile(join(context.cwd, name), "needle")));
    const gate = defer();
    const started = defer();
    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await actualFs.open(...args);
      active++;
      peak = Math.max(peak, active);
      const close = file.close.bind(file);
      vi.spyOn(file, "close").mockImplementation(async () => {
        await close();
        active--;
        completed.push(String(args[0]));
        if (completed.length === 3) started.resolve();
      });
      if (args[0] === join(context.cwd, names[0]!)) await gate.promise;
      return file;
    });
    const searching = searchTool({ query: "needle" }, context);
    try {
      await started.promise;
      expect(peak).toBe(4);
      expect(completed).not.toContain(join(context.cwd, names[0]!));
    } finally {
      gate.resolve();
    }
    const result = await searching;
    expect(result.matches.map(({ path }) => path)).toEqual(
      names.map((name) => join(context.cwd, name))
    );
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it("stops at the match limit without counting speculative read failures", async () => {
    const context = await workspace();
    await fs.writeFile(join(context.cwd, "a-hits"), "needle\n".repeat(51));
    await fs.writeFile(join(context.cwd, "b-unavailable"), "needle");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (args[0] === join(context.cwd, "b-unavailable"))
        throw Object.assign(new Error("I/O failed"), { code: "EIO" });
      return actualFs.open(...args);
    });
    expect(await searchTool({ query: "needle" }, context)).toMatchObject({
      matches: Array.from({ length: 50 }, (_, index) => ({
        path: join(context.cwd, "a-hits"),
        line: index + 1,
        text: "needle",
      })),
      skippedFiles: 0,
      truncated: true,
    });
  });

  it.each(["failure", "cancellation"] as const)(
    "drains active reads before returning a search %s",
    async (mode) => {
      const context = await workspace();
      await fs.writeFile(join(context.cwd, "a-fail"), "needle");
      await fs.writeFile(join(context.cwd, "b-slow"), "needle");
      const controller = new AbortController();
      const gate = defer();
      const started = defer();
      const reason = new Error("search cancelled");
      let closed = false;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        if (args[0] === join(context.cwd, "a-fail"))
          throw Object.assign(new Error("I/O failed"), { code: "EIO" });
        const file = await actualFs.open(...args);
        if (args[0] === join(context.cwd, "b-slow")) {
          const close = file.close.bind(file);
          vi.spyOn(file, "close").mockImplementation(async () => {
            await close();
            closed = true;
          });
          started.resolve();
          await gate.promise;
        }
        return file;
      });
      let settled = false;
      const result = searchTool({ query: "needle" }, { ...context, signal: controller.signal });
      const assertion =
        mode === "cancellation"
          ? expect(result).rejects.toBe(reason)
          : expect(result).rejects.toMatchObject({ code: "EIO" });
      void result.then(
        () => (settled = true),
        () => (settled = true)
      );
      await started.promise;
      if (mode === "cancellation") controller.abort(reason);
      expect(settled).toBe(false);
      gate.resolve();
      await assertion;
      expect(closed).toBe(true);
    }
  );

  it.each(["EACCES", "EPERM", "ENOENT", "ENOTDIR"])(
    "retains matches and counts a discovered file that fails with %s",
    async (code) => {
      const context = await workspace();
      for (const name of ["a-before", "b-unavailable", "c-after"])
        await fs.writeFile(join(context.cwd, name), "needle");
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        if (args[0] === join(context.cwd, "b-unavailable"))
          throw Object.assign(new Error("Unavailable"), { code });
        return actualFs.open(...args);
      });
      const result = await searchTool({ query: "needle" }, context);
      expect(result.matches.map(({ path }) => path)).toEqual([
        join(context.cwd, "a-before"),
        join(context.cwd, "c-after"),
      ]);
      expect(result.skippedFiles).toBe(1);
      // An explicitly requested file must still report its failure.
      await expect(
        searchTool({ query: "needle", path: "b-unavailable" }, context)
      ).rejects.toMatchObject({ code });
    }
  );

  it("skips inaccessible descendant directories but rejects an inaccessible root", async () => {
    const context = await workspace();
    await fs.mkdir(join(context.cwd, "a-unavailable"));
    await fs.writeFile(join(context.cwd, "z-after"), "needle");
    const error = Object.assign(new Error("Access denied"), { code: "EACCES" });
    directoryReads
      .mockResolvedValueOnce(await actualFs.readdir(context.cwd, { withFileTypes: true }))
      .mockRejectedValueOnce(error);
    expect(await searchTool({ query: "needle" }, context)).toMatchObject({
      matches: [{ path: join(context.cwd, "z-after"), line: 1, text: "needle" }],
      skippedFiles: 1,
    });
    directoryReads.mockRejectedValueOnce(error);
    await expect(searchTool({ query: "needle" }, context)).rejects.toMatchObject({
      code: "EACCES",
    });
    await expect(searchTool({ query: "needle", path: "missing" }, context)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not swallow cancellation or unexpected read failures", async () => {
    const context = await workspace();
    const controller = new AbortController();
    const reason = Object.assign(new Error("cancel search"), { code: "ENOENT" });
    vi.mocked(fs.open).mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      searchTool({ query: "needle" }, { ...context, signal: controller.signal })
    ).rejects.toBe(reason);
    vi.mocked(fs.open).mockRejectedValueOnce(
      Object.assign(new Error("I/O failed"), { code: "EIO" })
    );
    await expect(searchTool({ query: "needle" }, context)).rejects.toMatchObject({ code: "EIO" });
  });

  it.each([
    { prefix: "🙂".repeat(400), query: "needle", expected: "needle" },
    { prefix: "x".repeat(1022), query: "needle", expected: "needle" },
    { prefix: "🙂".repeat(400), query: "界".repeat(340), expected: "界".repeat(340) },
    { prefix: "x".repeat(2000), query: "y".repeat(2000), expected: "y".repeat(1024) },
  ])(
    "shows long-line matches within the UTF-8 snippet limit ($query.length characters)",
    async ({ prefix, query, expected }) => {
      const context = await workspace();
      await fs.writeFile(join(context.cwd, "long"), `header\n${prefix}${query}${"é".repeat(1000)}`);
      const result = await searchTool({ query, path: "long" }, context);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.line).toBe(2);
      expect(result.matches[0]!.text.startsWith(expected)).toBe(true);
      expect(Buffer.byteLength(result.matches[0]!.text)).toBeLessThanOrEqual(1024);
      expect(result.matches[0]!.text).not.toContain("�");
      expect(result.truncated).toBe(true);
    }
  );
});

describe("workspace file replacement", () => {
  it("serializes concurrent edits to one file so neither update is lost", async () => {
    const context = await workspace();
    const path = join(context.cwd, "target");
    await fs.writeFile(path, "alpha\nbeta\ngamma\n");
    const results = await Promise.all([
      editTool({ path: "target", oldText: "alpha", newText: "ALPHA" }, context),
      editTool({ path: "target", oldText: "gamma", newText: "GAMMA" }, context),
      writeTool({ path: "other", content: "independent" }, context),
      editTool({ path: "./target", oldText: "beta", newText: "BETA" }, context),
    ]);
    expect(results.map((result) => result.path)).toEqual([
      path,
      path,
      join(context.cwd, "other"),
      path,
    ]);
    expect(await fs.readFile(path, "utf8")).toBe("ALPHA\nBETA\nGAMMA\n");
  });

  it("releases a file after a failed edit", async () => {
    const context = await workspace();
    await expect(
      editTool({ path: "target", oldText: "missing", newText: "x" }, context)
    ).rejects.toMatchObject({ code: "EDIT_NOT_FOUND" });
    await editTool({ path: "target", oldText: "original", newText: "updated" }, context);
    expect(await fs.readFile(join(context.cwd, "target"), "utf8")).toBe("updated content");
  });

  for (const tool of ["write", "edit"] as const) {
    it(`${tool} restores setuid, setgid, and sticky bits after restoring ownership`, async () => {
      const context = await workspace();
      const path = join(context.cwd, "target");
      await fs.chmod(path, 0o751);
      const before = await fs.stat(path);
      // Some filesystems strip special bits even during fixture setup. Model those
      // bits at the metadata boundary and verify restoration order explicitly.
      vi.mocked(fs.lstat).mockResolvedValueOnce(
        Object.assign(await fs.lstat(path), { mode: (before.mode & ~0o7777) | 0o7751 })
      );
      const restored: string[] = [];
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const file = await actualFs.open(...args);
        if (args[1] === "wx") {
          const chown = file.chown.bind(file);
          const chmod = file.chmod.bind(file);
          vi.spyOn(file, "chown").mockImplementation(async (uid, gid) => {
            expect([uid, gid]).toEqual([before.uid, before.gid]);
            await chown(uid, gid);
            restored.push("ownership");
          });
          vi.spyOn(file, "chmod").mockImplementation(async (mode) => {
            expect(restored).toEqual(["ownership"]);
            expect(mode).toBe(0o7751);
            await chmod(0o751);
            restored.push("mode");
          });
        }
        return file;
      });
      if (tool === "write")
        await writeTool({ path: "target", content: "updated content" }, context);
      else await editTool({ path: "target", oldText: "original", newText: "updated" }, context);
      expect(restored).toEqual(["ownership", "mode"]);
      expect(await fs.readFile(path, "utf8")).toBe("updated content");
      expect(await fs.stat(path)).toMatchObject({
        uid: before.uid,
        gid: before.gid,
        mode: before.mode,
      });
    });

    it.each(["staging directory", "ownership restoration"])(
      `${tool} preserves the original when permissions block %s`,
      async (failure) => {
        const context = await workspace();
        const before = await fs.stat(join(context.cwd, "target"));
        const code = failure === "staging directory" ? "EACCES" : "EPERM";
        const error = Object.assign(new Error("Permission denied"), { code });
        if (failure === "staging directory") vi.mocked(fs.mkdtemp).mockRejectedValueOnce(error);
        else
          vi.mocked(fs.open).mockImplementation(async (...args) => {
            const file = await actualFs.open(...args);
            vi.spyOn(file, "chown").mockImplementation(async (uid, gid) => {
              expect([uid, gid]).toEqual([before.uid, before.gid]);
              throw error;
            });
            return file;
          });
        const operation =
          tool === "write"
            ? writeTool({ path: "target", content: "replacement" }, context)
            : editTool({ path: "target", oldText: "original", newText: "replacement" }, context);
        await expect(operation).rejects.toMatchObject({ code });
        expect(await fs.readFile(join(context.cwd, "target"), "utf8")).toBe("original content");
        expect(await fs.stat(join(context.cwd, "target"))).toMatchObject({
          ino: before.ino,
          uid: before.uid,
          gid: before.gid,
          mode: before.mode,
        });
        expect(await fs.readdir(context.cwd)).toEqual(["target"]);
      }
    );

    it.each(["cancel during write", "cancel before rename", "write error"])(
      `${tool} preserves the destination on %s and removes staging files`,
      async (failure) => {
        const context = await workspace();
        const controller = new AbortController();
        const reason = new Error("stop writing");
        vi.mocked(fs.open).mockImplementation(async (...args) => {
          const file = await actualFs.open(...args);
          const write = file.writeFile.bind(file);
          vi.spyOn(file, "writeFile").mockImplementation(async (...writeArgs) => {
            if (failure === "cancel before rename") {
              await write(...writeArgs);
              controller.abort(reason);
              return;
            }
            await write("partial");
            if (failure === "write error")
              throw Object.assign(new Error("No space left"), { code: "ENOSPC" });
            controller.abort(reason);
            await write(...writeArgs);
          });
          return file;
        });
        const operation =
          tool === "write"
            ? writeTool(
                { path: "target", content: "replacement" },
                { ...context, signal: controller.signal }
              )
            : editTool(
                { path: "target", oldText: "original", newText: "replacement" },
                { ...context, signal: controller.signal }
              );
        if (failure === "write error")
          await expect(operation).rejects.toMatchObject({ code: "ENOSPC" });
        else await expect(operation).rejects.toBe(reason);
        expect(await fs.readFile(join(context.cwd, "target"), "utf8")).toBe("original content");
        expect((await fs.stat(join(context.cwd, "target"))).mode & 0o777).toBe(0o771);
        expect(await fs.readdir(context.cwd)).toEqual(["target"]);
      }
    );
  }

  it("preserves existing symlinks and the destination's ownership and permission bits", async () => {
    const context = await workspace();
    const before = await fs.stat(join(context.cwd, "target"));
    await fs.symlink("target", join(context.cwd, "link"));
    await editTool({ path: "link", oldText: "original", newText: "updated" }, context);
    expect(await fs.readlink(join(context.cwd, "link"))).toBe("target");
    expect(await fs.readFile(join(context.cwd, "target"), "utf8")).toBe("updated content");
    expect(await fs.stat(join(context.cwd, "target"))).toMatchObject({
      uid: before.uid,
      gid: before.gid,
      mode: before.mode,
    });
    expect((await fs.readdir(context.cwd)).sort()).toEqual(["link", "target"]);
  });

  it.each(["relative", "absolute", "chained"])(
    "creates a missing target through a %s symlink without replacing the link",
    async (kind) => {
      const context = await workspace();
      const destination = join(context.cwd, "missing", "created");
      const target =
        kind === "absolute" ? destination : kind === "chained" ? "next" : "missing/created";
      await fs.symlink(target, join(context.cwd, "link"));
      if (kind === "chained") await fs.symlink("missing/created", join(context.cwd, "next"));
      expect(await writeTool({ path: "link", content: "created" }, context)).toEqual({
        path: join(context.cwd, "link"),
        bytes: 7,
      });
      expect(await fs.readlink(join(context.cwd, "link"))).toBe(target);
      if (kind === "chained")
        expect(await fs.readlink(join(context.cwd, "next"))).toBe("missing/created");
      expect(await fs.readFile(destination, "utf8")).toBe("created");
    }
  );

  it("resolves directory symlinks before parent traversal in a missing target", async () => {
    const context = await workspace();
    await fs.mkdir(join(context.cwd, "real", "child"), { recursive: true });
    await fs.symlink("real/child", join(context.cwd, "alias"));
    await fs.symlink("alias/../created", join(context.cwd, "link"));
    await writeTool({ path: "link", content: "created" }, context);
    expect(await fs.readlink(join(context.cwd, "link"))).toBe("alias/../created");
    expect(await fs.readFile(join(context.cwd, "real", "created"), "utf8")).toBe("created");
    await expect(fs.lstat(join(context.cwd, "created"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects cyclic symlinks without replacing them", async () => {
    const context = await workspace();
    await fs.symlink("second", join(context.cwd, "first"));
    await fs.symlink("first", join(context.cwd, "second"));
    await expect(writeTool({ path: "first", content: "new" }, context)).rejects.toMatchObject({
      code: "ELOOP",
    });
    expect(await fs.readlink(join(context.cwd, "first"))).toBe("second");
    expect(await fs.readlink(join(context.cwd, "second"))).toBe("first");
  });

  it("does not turn a missing directory symlink target into a regular file", async () => {
    const context = await workspace();
    await fs.symlink("missing/", join(context.cwd, "link"));
    await expect(writeTool({ path: "link", content: "new" }, context)).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOENT|ENOTDIR)$/),
    });
    expect(await fs.readlink(join(context.cwd, "link"))).toBe("missing/");
    await expect(fs.lstat(join(context.cwd, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(context.cwd)).sort()).toEqual(["link", "target"]);
  });

  it("preserves the destination and cleans staging when replacement fails", async () => {
    const context = await workspace();
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error("Rename denied"), { code: "EACCES" })
    );
    await expect(
      writeTool({ path: "target", content: "replacement" }, context)
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(await fs.readFile(join(context.cwd, "target"), "utf8")).toBe("original content");
    expect(await fs.readdir(context.cwd)).toEqual(["target"]);
  });
});
