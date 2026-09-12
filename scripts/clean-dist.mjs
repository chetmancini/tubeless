import { rmSync } from "node:fs";

// Every build emits the full package; start clean so removed modules cannot survive.
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
