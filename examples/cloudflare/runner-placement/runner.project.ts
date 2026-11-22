import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerProject } from "./project.js";

export default runnerProject({
  async writeLocal(cwd, text, signal) {
    const file = join(cwd, "normalized.txt");
    await writeFile(file, text, { encoding: "utf8", signal });
    return readFile(file, { encoding: "utf8", signal });
  },
});
