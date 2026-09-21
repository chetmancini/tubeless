import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "../core/pipeline.js";
import { definePipelineCommand } from "./cli.js";

function pipeline<TInput extends object, TOutput extends object = TInput>(
  input: Record<string, unknown>,
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"]
) {
  const schema: StandardSchemaV1<TInput, TOutput> = {
    "~standard": { version: 1, vendor: "test", validate, jsonSchema: { input: () => input } },
  };
  const { step } = createSteps(schema);
  const work = step("work", { run: (_inputs, context) => context.options });
  return definePipeline({ id: "automatic", steps: [work], finalize: (outputs) => outputs.work! });
}

describe("inferred pipeline CLI", () => {
  it("retains skip-aware dependency types on schema-backed steps", () => {
    const schema: StandardSchemaV1<{ name: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: value as { name: string } }),
        jsonSchema: {
          input: () => ({
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          }),
        },
      },
    };
    const { step, fromPipeline, forEachPipeline } = createSteps(schema);
    const maybe = step("maybe", { skip: () => "optional", run: () => "value" as const });
    const dependent = step("dependent", {
      dependsOn: [maybe],
      run: ({ maybe }) => {
        expectTypeOf(maybe).toEqualTypeOf<"value" | undefined>();
        return maybe;
      },
    });
    const child = definePipeline({ id: "child", steps: [maybe, dependent] });
    const single = fromPipeline("single", {
      pipeline: child,
      mapOptions: (_inputs, context) => context.options,
    });
    const many = forEachPipeline("many", {
      pipeline: child,
      items: () => ["a"],
      key: (item) => item,
      mapOptions: (name) => ({ name }),
    });
    for (const command of [
      definePipelineCommand(child),
      definePipelineCommand(definePipeline({ id: "parent", steps: [single, many] })),
    ]) {
      expect(command.parse(["--name", "Ada"]).kind).toBe("values");
    }
  });
  it("derives flags, defaults, choices, bounds and descriptors without running validation", async () => {
    interface Options {
      displayName: string;
      count?: number;
      format?: "json" | "text";
      enabled?: boolean;
      labels: readonly string[];
    }
    const validate = vi.fn((value: unknown) => ({ value: value as Options }));
    const command = definePipelineCommand(
      pipeline<Options>(
        {
          type: "object",
          properties: {
            displayName: { type: "string", description: "Name to display." },
            count: { type: "integer", minimum: 1, maximum: 10, default: 3 },
            format: { type: "string", enum: ["json", "text"] },
            enabled: { type: "boolean", default: true },
            labels: { type: "array", items: { type: "string" } },
          },
          required: ["displayName", "labels"],
        },
        validate
      )
    );
    expect(command.parse(["--help"]).kind).toBe("help");
    expect(command.plan().ok).toBe(true);
    expect(validate).not.toHaveBeenCalled();
    expect(command.descriptor.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "displayName",
          flag: "display-name",
          required: true,
          description: "Name to display.",
        }),
        expect.objectContaining({ key: "count", integer: true, min: 1, max: 10, default: 3 }),
        expect.objectContaining({ key: "format", choices: ["json", "text"], required: false }),
        expect.objectContaining({ key: "labels", multiple: true }),
      ])
    );
    expect(command.parse([]).kind).toBe("error");
    for (const argv of [
      ["--count", "0"],
      ["--count", "1.5"],
      ["--count", "11"],
      ["--format", "xml"],
    ]) {
      expect(command.parse(["--display-name", "Ada", ...argv]).kind).toBe("error");
    }
    const parsed = command.parse([
      "--display-name",
      "Ada",
      "--labels",
      "a",
      "--labels",
      "b",
      "--no-enabled",
    ]);
    expect(parsed.kind).toBe("values");
    if (parsed.kind !== "values") throw new Error("expected values");
    expectTypeOf(parsed.values.displayName).toEqualTypeOf<string>();
    expectTypeOf(parsed.values.format).toEqualTypeOf<"json" | "text" | undefined>();
    expectTypeOf(parsed.values.labels).toEqualTypeOf<readonly string[]>();
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(await command.execute(parsed.values, { log })).toEqual({
      displayName: "Ada",
      count: 3,
      format: undefined,
      enabled: false,
      labels: ["a", "b"],
    });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(command.parseValues({ displayName: "Ada", labels: ["a", "b"], enabled: false })).toEqual(
      parsed
    );
  });

  it("uses input metadata and retains async schema transformations and failures", async () => {
    const validate = vi.fn(async (value: unknown) => {
      const { source } = value as { source: string };
      return source === "bad"
        ? { issues: [{ message: "Bad source", path: ["source"] }] }
        : { value: { length: source.length } };
    });
    const source = pipeline<{ source: string }, { length: number }>(
      {
        type: "object",
        properties: { source: { type: "string" } },
        required: ["source"],
      },
      validate
    );
    const command = definePipelineCommand(source, { reporter: false });
    expect(await command.run(["--source", "abc"])).toEqual({ length: 3 });
    await expect(command.run(["--source", "bad"])).rejects.toThrow();
    expect(command.parse(["--length", "3"]).kind).toBe("error");
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("supports metadata overrides without repeating the parameter types", () => {
    const source = pipeline<{ source: string }>(
      {
        type: "object",
        properties: { source: { type: "string" } },
        required: ["source"],
      },
      (value) => ({ value: value as { source: string } })
    );
    const command = definePipelineCommand(source, {
      overrides: {
        source: { short: "s", env: "SOURCE", flag: "input", description: "Input source." },
      },
    });
    const parsed = command.parse(["-s", "file"]);
    expect(command.parse([], { env: { SOURCE: "file" } })).toEqual(parsed);
    expect(command.parse(["--input", "file"])).toEqual(parsed);
    expect(command.descriptor.parameters).toContainEqual(
      expect.objectContaining({
        key: "source",
        short: "s",
        flag: "input",
        environment: "SOURCE",
        description: "Input source.",
      })
    );
    expect(() =>
      definePipelineCommand(source, { overrides: { source: { flag: "target" } } })
    ).toThrow("reserved flag");
    expect(() =>
      definePipelineCommand(source, {
        // @ts-expect-error Overrides must name pipeline inputs.
        overrides: { missing: { short: "m" } },
      })
    ).toThrow("override does not name an option");
  });

  it("resolves local references and supports repeated numbers", () => {
    const command = definePipelineCommand(
      pipeline<{ amounts: readonly number[] }>(
        {
          type: "object",
          properties: { amounts: { type: "array", items: { $ref: "#/$defs/amount" } } },
          $defs: { amount: { type: "integer", minimum: 1 } },
        },
        (value) => ({ value: value as { amounts: number[] } })
      )
    );
    const parsed = command.parse(["--amounts", "1", "--amounts", "2"]);
    expect(parsed.kind === "values" && parsed.values.amounts).toEqual([1, 2]);
    expect(command.parse(["--amounts", "0"]).kind).toBe("error");
  });

  it.each([
    { type: "number", enum: [1, 2] },
    { type: "integer", enum: [1, 2] },
    { type: "boolean", enum: [true] },
    { type: "number", const: 0 },
    { type: "integer", const: 0 },
    { type: "boolean", const: false },
    { enum: [1, 2] },
    { enum: [true] },
    { const: 0 },
    { const: false },
    { type: "array", items: { type: "number", enum: [1, 2] } },
    { type: "array", items: { type: "integer", const: 0 } },
    { $ref: "#/$defs/restricted" },
  ])("rejects non-string choices before exposing an unrestricted flag: %j", (field) => {
    const validate = vi.fn(() => ({ value: {} }));
    const source = pipeline(
      {
        type: "object",
        properties: { value: field },
        $defs: { restricted: { type: "number", enum: [1, 2] } },
      },
      validate
    );
    expect(() => definePipelineCommand(source)).toThrow(
      /Cannot infer CLI flags for value: non-string enum and const constraints.*Supply explicit params/
    );
    expect(validate).not.toHaveBeenCalled();
    expect(() =>
      definePipelineCommand(source, { params: {}, mapOptions: () => ({}) })
    ).not.toThrow();
  });

  it.each([
    { type: "string", const: "json" },
    { const: "json" },
    { type: "string", enum: ["json"] },
    { enum: ["json"] },
  ])("preserves string choices: %j", (field) => {
    const source = pipeline<{ format: "json" }>(
      {
        type: "object",
        properties: { format: field },
        required: ["format"],
      },
      () => ({ value: { format: "json" } })
    );
    const command = definePipelineCommand(source);
    expect(command.parse(["--format", "json"]).kind).toBe("values");
    expect(command.parse(["--format", "text"]).kind).toBe("error");
    expect(command.parseValues({ format: "text" }).kind).toBe("error");
    expect(command.descriptor.parameters).toContainEqual(
      expect.objectContaining({ key: "format", choices: ["json"] })
    );
  });

  it.each([
    { type: "object", properties: { x: { type: "object" } } },
    { type: "object", properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] } } },
    { type: "object", properties: { x: { type: "array", items: { type: "boolean" } } } },
    {
      type: "object",
      properties: { x: { type: "array", items: { type: "string" }, default: ["a"] } },
    },
    {
      type: "object",
      properties: { x: { $ref: "#/$defs/x" } },
      $defs: { x: { $ref: "#/$defs/x" } },
    },
    { type: "object", properties: { x: { $ref: "https://example.com/schema" } } },
    { type: "array" },
  ])("rejects unsupported metadata with an explicit escape hatch: %j", (metadata) => {
    const source = pipeline(metadata, () => ({ value: {} }));
    expect(() => definePipelineCommand(source)).toThrow(/Supply explicit params/);
    expect(() =>
      definePipelineCommand(source, { params: {}, mapOptions: () => ({}) })
    ).not.toThrow();
  });

  it.each([
    { type: "object", additionalProperties: { type: "string" } },
    {
      type: "object",
      patternProperties: { "^label-": { type: "string" } },
      additionalProperties: false,
    },
  ])("rejects dynamic-key option schemas before exposing an unusable command: %j", (metadata) => {
    const source = pipeline(metadata, () => ({ value: {} }));
    expect(() => definePipelineCommand(source)).toThrow(
      /dynamic property schemas need explicit parameters.*Supply explicit params/
    );
    expect(() =>
      definePipelineCommand(source, { params: {}, mapOptions: () => ({}) })
    ).not.toThrow();
  });

  it("requires explicit flags for validation-only schemas and supports zero-option pipelines", () => {
    const { step } = createSteps({
      "~standard": { version: 1, vendor: "test", validate: () => ({ value: {} }) },
    });
    const source = definePipeline({ id: "opaque", steps: [step("work", { run: () => 1 })] });
    expect(() => definePipelineCommand(source)).toThrow("Standard JSON Schema");
    expect(definePipelineCommand(source, { params: {} }).parse([]).kind).toBe("values");
    const { step: plain } = createSteps();
    const empty = definePipeline({ id: "empty", steps: [plain("work", { run: () => 1 })] });
    expect(definePipelineCommand(empty).parse([]).kind).toBe("values");
  });
});
