import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editTool, writeTool } from "./default-tool-files.js";

vi.mock("node:fs/promises", { spy: true });
const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
const directories: string[] = [];
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
  await Promise.all(
    directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  );
});

describe("workspace file replacement", () => {
  for (const tool of ["write", "edit"] as const) {
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

  it("preserves existing symlinks and the destination's permission bits", async () => {
    const context = await workspace();
    await fs.symlink("target", join(context.cwd, "link"));
    await editTool({ path: "link", oldText: "original", newText: "updated" }, context);
    expect(await fs.readlink(join(context.cwd, "link"))).toBe("target");
    expect(await fs.readFile(join(context.cwd, "target"), "utf8")).toBe("updated content");
    expect((await fs.stat(join(context.cwd, "target"))).mode & 0o777).toBe(0o771);
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
