import { describe, expect, it } from "vitest";
import {
  definePipelineStudio,
  isPipelineStudioConfig,
  PIPELINE_STUDIO_CONFIG_VERSION,
} from "./workbench-studio.js";

describe("pipeline studio config", () => {
  it("defines an immutable, versioned command manifest", () => {
    const config = definePipelineStudio({
      commands: [
        { export: "SeedCommand", file: "./seed.ts", name: "Seed database" },
        { file: "./geo.ts" },
      ],
      cwd: "..",
    });

    expect(config).toEqual({
      commands: [
        { export: "SeedCommand", file: "./seed.ts", name: "Seed database" },
        { file: "./geo.ts" },
      ],
      cwd: "..",
      version: PIPELINE_STUDIO_CONFIG_VERSION,
    });
    expect(isPipelineStudioConfig(config)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.commands)).toBe(true);
    expect(Object.isFrozen(config.commands[0])).toBe(true);
    expect(isPipelineStudioConfig({ commands: config.commands, version: 1 })).toBe(false);
  });

  it("rejects empty, malformed, and duplicate registrations", () => {
    expect(() => definePipelineStudio({ commands: [] })).toThrow("at least one command");
    expect(() => definePipelineStudio({ commands: [{ file: "" }] })).toThrow(
      "command 1 file must be a non-empty string"
    );
    expect(() =>
      definePipelineStudio({ commands: [{ file: "./seed.ts" }, { file: "./seed.ts" }] })
    ).toThrow("is declared more than once");
  });
});
