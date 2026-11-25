import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerProject } from "./project.js";

export default runnerProject({
  async readLocal(cwd, file, signal) {
    if (file !== "local-source.txt") throw new Error("Use local-source.txt as the input file.");
    return readFile(join(cwd, file), { encoding: "utf8", signal });
  },
  async saveLocal(cwd, text, signal) {
    await writeFile(join(cwd, "local-result.txt"), text, { encoding: "utf8", signal });
  },
  async writeLocal(cwd, text, signal) {
    const file = join(cwd, "normalized.txt");
    signal?.throwIfAborted();
    await writeFile(file, text, { encoding: "utf8", signal });
    await appendFile(join(cwd, "normalize-writes.ndjson"), JSON.stringify(text) + "\n", "utf8");
    return readFile(file, { encoding: "utf8", signal });
  },
});
