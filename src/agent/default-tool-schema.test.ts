import { expect, expectTypeOf, it } from "vitest";
import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { wireArray, wireNumber, wireString } from "../tracing/wire-schema.js";
import { optionalToolField, toolObject } from "./default-tool-schema.js";

it("infers object fields and preserves nullable optional inputs", async () => {
  const schema = toolObject({
    path: wireString(),
    maxLines: optionalToolField(wireNumber()),
  });
  expectTypeOf(schema).toEqualTypeOf<
    StandardSchemaV1<{ path: string } & { maxLines?: number | null }>
  >();
  expect(await schema["~standard"].validate({ path: "note.txt" })).toEqual({
    value: { path: "note.txt" },
  });
  expect(await schema["~standard"].validate({ path: "note.txt", maxLines: null })).toEqual({
    value: { path: "note.txt", maxLines: null },
  });
  expect(await schema["~standard"].validate({ path: "note.txt", ignored: true })).toHaveProperty(
    "issues"
  );

  const invalidSchemas = () => {
    // @ts-expect-error Accept object field maps, not an arbitrary scalar schema.
    toolObject(wireString());
    // @ts-expect-error Arrays are not object field maps either.
    toolObject(wireArray(wireString()));
  };
  void invalidSchemas;
});
