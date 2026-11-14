import { readFile, writeFile, rm, symlink, access, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentTestWorkspace } from "./testing.js";

vi.mock("node:fs/promises", { spy: true });
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

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

  it("checks selected paths without reading unrelated files or directories", async () => {
    const workspace = await createAgentTestWorkspace({
      "src/preserved.txt": "preserve",
      "unrelated.bin": "unreadable output",
      "build/artifact.bin": "unreadable output",
    });
    vi.mocked(readFile).mockImplementation((path, ...options) => {
      if (String(path).endsWith(".bin")) throw new Error("Unrelated file is unreadable");
      return actualFs.readFile(path, ...options);
    });
    vi.mocked(readdir).mockImplementation((path, ...options) => {
      if (String(path).endsWith("/build")) throw new Error("Unrelated directory is unreadable");
      return actualFs.readdir(path, ...options);
    });
    try {
      await expect(workspace.assertUnchanged(["src/preserved.txt"])).resolves.toBeUndefined();
      await expect(workspace.assertUnchanged(["src"])).resolves.toBeUndefined();
      await expect(workspace.assertUnchanged()).rejects.toThrow("unreadable");
      await writeFile(join(workspace.cwd, "src/new.txt"), "new");
      await expect(workspace.assertUnchanged(["src/preserved.txt"])).resolves.toBeUndefined();
      await expect(workspace.assertUnchanged(["src"])).rejects.toThrow("Workspace changed");
      await rm(join(workspace.cwd, "src"), { recursive: true });
      await symlink("build", join(workspace.cwd, "src"));
      await expect(workspace.assertUnchanged(["src/preserved.txt"])).rejects.toThrow(
        "Workspace changed: src"
      );
    } finally {
      vi.mocked(readFile).mockRestore();
      vi.mocked(readdir).mockRestore();
      await workspace.close();
    }
  });
});
