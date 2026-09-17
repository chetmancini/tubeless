import * as fs from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { writeAtomicText } from "./atomic-text.js";

vi.mock("fs", { spy: true });

it("keeps overlapping writes in the same process on independent temporary files", async () => {
  const actualFs = await vi.importActual<typeof import("fs")>("fs");
  const dir = fs.mkdtempSync(join(tmpdir(), "atomic-text-test-"));
  const file = join(dir, "artifact.json");
  const first = '{"writer":"first"}\n';
  const second = '{"writer":"second"}\n';

  // Reproduce two same-PID writers: finish the second after the first writes its
  // temporary file, but before it renames. No worker scheduling race is needed.
  vi.mocked(fs.renameSync).mockImplementationOnce((source, destination) => {
    writeAtomicText(file, second);
    expect(fs.readFileSync(file, "utf8")).toBe(second);
    actualFs.renameSync(source, destination);
  });

  try {
    writeAtomicText(file, first);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
    expect(fs.readdirSync(dir)).toEqual(["artifact.json"]);
  } finally {
    vi.mocked(fs.renameSync).mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
