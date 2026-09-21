import { describe, expect, it } from "vitest";
import {
  COMMAND_CATALOG_VERSION,
  defineCommandCatalog,
  isCommandCatalog,
} from "./command-catalog.js";

describe("command catalog", () => {
  it("defines an immutable, versioned catalog with stable ids", () => {
    const catalog = defineCommandCatalog({
      commands: [
        { export: "SeedCommand", file: "./seed.ts", id: "seed", name: "Seed database" },
        { file: "./geo.ts", id: "geocode" },
      ],
      cwd: "..",
    });

    expect(catalog).toEqual({
      commands: [
        { export: "SeedCommand", file: "./seed.ts", id: "seed", name: "Seed database" },
        { file: "./geo.ts", id: "geocode" },
      ],
      cwd: "..",
      version: COMMAND_CATALOG_VERSION,
    });
    expect(isCommandCatalog(catalog)).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.commands)).toBe(true);
    expect(Object.isFrozen(catalog.commands[0])).toBe(true);
    expect(isCommandCatalog({ commands: catalog.commands, version: 1 })).toBe(false);
  });

  it("rejects empty, malformed, and duplicate registrations", () => {
    expect(() => defineCommandCatalog({ commands: [] })).toThrow("at least one command");
    expect(() => defineCommandCatalog({ commands: [{ file: "./seed.ts", id: "" }] })).toThrow(
      "entry 1 id must be a non-empty string"
    );
    expect(() =>
      defineCommandCatalog({
        commands: [
          { file: "./seed.ts", id: "seed" },
          { file: "./geo.ts", id: "seed" },
        ],
      })
    ).toThrow('catalog id "seed" is declared more than once');
    expect(() =>
      defineCommandCatalog({
        commands: [
          { file: "./seed.ts", id: "seed" },
          { file: "./seed.ts", id: "seed-again" },
        ],
      })
    ).toThrow('module "./seed.ts" is declared more than once');
  });
});
