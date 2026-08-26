import * as path from "path";
import { describe, expect, it } from "vitest";
import { definePaths } from "./paths";

describe("definePaths", () => {
  it("joins each relative path against the given cwd", () => {
    const paths = definePaths({
      entitiesDir: "public/data/entity-index/entities",
      rawInPath: "scripts/data/entity-candidates-raw.json",
    });

    const resolved = paths("/tmp/workspace");

    expect(resolved.entitiesDir).toBe(
      path.join("/tmp/workspace", "public/data/entity-index/entities")
    );
    expect(resolved.rawInPath).toBe(
      path.join("/tmp/workspace", "scripts/data/entity-candidates-raw.json")
    );
  });

  it("re-resolves against a different cwd on each call, instead of caching the first one", () => {
    const paths = definePaths({ dataDir: "scripts/data" });

    expect(paths("/tmp/a").dataDir).toBe(path.join("/tmp/a", "scripts/data"));
    expect(paths("/tmp/b").dataDir).toBe(path.join("/tmp/b", "scripts/data"));
  });
});
