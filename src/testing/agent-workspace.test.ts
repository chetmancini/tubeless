import { readFile, writeFile, rm, symlink, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentTestWorkspace } from "./testing.js";

describe("agent evaluation workspace", () => {
  it("creates physical fixture paths and preserves selected files while allowing intentional edits", async () => {
    const workspace = await createAgentTestWorkspace({
      "src/work.txt": "before",
      "check.mjs": "preserve",
    });
    try {
      expect(await readFile(join(workspace.cwd, "src/work.txt"), "utf8")).toBe("before");
      await writeFile(join(workspace.cwd, "src/work.txt"), "after");
      await expect(workspace.assertUnchanged(["check.mjs"])).resolves.toBeUndefined();
      await expect(workspace.assertUnchanged(["src"])).rejects.toThrow("Workspace changed");
      await expect(workspace.assertUnchanged()).rejects.toThrow("Workspace changed");
    } finally {
      await workspace.close();
    }
    await expect(access(workspace.cwd)).rejects.toThrow();
    await workspace.close();
    await expect(workspace.assertUnchanged()).rejects.toThrow("closed");
  });

  it.each(["add", "remove", "directory", "link"])(
    "detects %s without reading link targets",
    async (kind) => {
      const workspace = await createAgentTestWorkspace({ "original.txt": "preserve" });
      try {
        if (kind === "add") await writeFile(join(workspace.cwd, "extra.txt"), "new");
        if (kind === "remove") await rm(join(workspace.cwd, "original.txt"));
        if (kind === "directory") await mkdir(join(workspace.cwd, "extra"));
        if (kind === "link") await symlink("/does-not-exist", join(workspace.cwd, "link"));
        await expect(workspace.assertUnchanged()).rejects.toThrow("Workspace changed");
      } finally {
        await workspace.close();
      }
    }
  );

  it("rejects fixture paths and assertion paths outside the owned workspace", async () => {
    for (const name of ["../escape", "/absolute", ".", "bad\0path"])
      await expect(createAgentTestWorkspace({ [name]: "content" })).rejects.toThrow(
        "Fixture paths"
      );
    const workspace = await createAgentTestWorkspace({ "ok.txt": "preserve" });
    try {
      await expect(workspace.assertUnchanged(["../escape"])).rejects.toThrow("Fixture paths");
    } finally {
      await workspace.close();
    }
  });
});
