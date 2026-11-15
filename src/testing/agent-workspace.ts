/** A disposable Node/Bun workspace whose initial file tree can be checked after a run. */
export interface AgentTestWorkspace {
  readonly cwd: string;
  /** Check the whole tree, or selected relative files/directories, for additions, changes and deletions. */
  assertUnchanged(paths?: readonly string[]): Promise<void>;
  /** Remove only this helper's owned temporary directory; repeated calls share the same cleanup. */
  close(): Promise<void>;
}

/** Naming options for a disposable evaluation workspace. */
export interface AgentTestWorkspaceOptions {
  /** A short name for the temporary directory, using letters, digits and hyphens. Defaults to agent. */
  readonly name?: string;
}

/** Create text fixtures in an owned temporary directory. Node filesystem modules load only here. */
export async function createAgentTestWorkspace(
  files: Readonly<Record<string, string>>,
  { name = "agent" }: AgentTestWorkspaceOptions = {}
): Promise<AgentTestWorkspace> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name))
    throw new Error("Invalid evaluation workspace name");
  const [fs, path, os, crypto] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:os"),
    import("node:crypto"),
  ]);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `tubeless-eval-${name}-`));
  try {
    const cwd = await fs.realpath(temporary);
    const localPath = (name: string) => {
      const target = path.resolve(cwd, name);
      const relative = path.relative(cwd, target);
      if (
        !name ||
        name.includes("\0") ||
        path.isAbsolute(name) ||
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("Fixture paths must stay inside the evaluation workspace");
      return { target, relative: relative.split(path.sep).join("/") };
    };
    const entries = Object.entries(files).map(([name, content]) => {
      if (typeof content !== "string") throw new TypeError("Fixture content must be text");
      return { ...localPath(name), content };
    });
    for (const { target, content } of entries) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const snapshot = async (includes: (name: string) => boolean = () => true) => {
      const entries = new Map<string, string>();
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          const key = path.relative(cwd, target).split(path.sep).join("/");
          if (!includes(key)) continue;
          if (entry.isSymbolicLink()) entries.set(key, `link:${await fs.readlink(target)}`);
          else if (entry.isDirectory()) {
            entries.set(key, "directory");
            await walk(target);
          } else if (entry.isFile())
            entries.set(
              key,
              "file:" +
                crypto
                  .createHash("sha256")
                  .update(await fs.readFile(target))
                  .digest("hex")
            );
          else entries.set(key, "special");
        }
      };
      await walk(cwd);
      return entries;
    };
    const initial = await snapshot();
    let closing: Promise<void> | undefined;
    return {
      cwd,
      async assertUnchanged(paths) {
        if (closing) throw new Error("Evaluation workspace is closed");
        const selected = paths?.map((name) => localPath(name).relative);
        // Include parents so replacing a selected file's directory cannot hide a change.
        const includes = (name: string) =>
          selected === undefined ||
          selected.some(
            (root) => name === root || name.startsWith(root + "/") || root.startsWith(name + "/")
          );
        const current = await snapshot(includes);
        for (const name of new Set([...initial.keys(), ...current.keys()])) {
          if (!includes(name)) continue;
          if (initial.get(name) !== current.get(name))
            throw new Error(`Workspace changed: ${name}`);
        }
      },
      close() {
        return (closing ??= fs.rm(cwd, { recursive: true, force: true }));
      },
    };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
