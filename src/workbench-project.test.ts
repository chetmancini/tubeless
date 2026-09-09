import { describe, expect, it } from "vitest";
import {
  definePipelineProject,
  isPipelineProjectManifest,
  PIPELINE_PROJECT_MANIFEST_VERSION,
} from "./workbench-project.js";

describe("pipeline project manifest", () => {
  it("defines an immutable, versioned command manifest with stable ids", () => {
    const manifest = definePipelineProject({
      commands: [
        { export: "SeedCommand", file: "./seed.ts", id: "seed", name: "Seed database" },
        { file: "./geo.ts", id: "geocode" },
      ],
      cwd: "..",
    });

    expect(manifest).toEqual({
      commands: [
        { export: "SeedCommand", file: "./seed.ts", id: "seed", name: "Seed database" },
        { file: "./geo.ts", id: "geocode" },
      ],
      cwd: "..",
      version: PIPELINE_PROJECT_MANIFEST_VERSION,
    });
    expect(isPipelineProjectManifest(manifest)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.commands)).toBe(true);
    expect(Object.isFrozen(manifest.commands[0])).toBe(true);
    expect(isPipelineProjectManifest({ commands: manifest.commands, version: 1 })).toBe(false);
  });

  it("rejects empty, malformed, and duplicate registrations", () => {
    expect(() => definePipelineProject({ commands: [] })).toThrow("at least one command");
    expect(() => definePipelineProject({ commands: [{ file: "./seed.ts", id: "" }] })).toThrow(
      "command 1 id must be a non-empty string"
    );
    expect(() =>
      definePipelineProject({
        commands: [
          { file: "./seed.ts", id: "seed" },
          { file: "./geo.ts", id: "seed" },
        ],
      })
    ).toThrow('command id "seed" is declared more than once');
    expect(() =>
      definePipelineProject({
        commands: [
          { file: "./seed.ts", id: "seed" },
          { file: "./seed.ts", id: "seed-again" },
        ],
      })
    ).toThrow('command "./seed.ts" is declared more than once');
  });
});
