import { afterEach, describe, expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { defineAgent, defineTool, type AgentModel, type AgentModelDescriptors } from "./agent.js";
import { anthropicModel } from "./anthropic.js";
import { openaiModel } from "./openai.js";
import { remote } from "./environment.test-support.js";

const schema = <T = unknown>(descriptor: Record<string, unknown>): StandardSchemaV1<T> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    // SAFETY: fixtures accept their declared shape; these tests exercise descriptors only.
    validate: (value) => ({ value: value as T }),
    jsonSchema: { input: () => descriptor },
  },
});
const files = schema<{ files: string[] }>({
  type: "object",
  properties: { files: { type: "array", items: { type: "string" } } },
  required: ["files"],
  additionalProperties: false,
});
// OpenAI strict mode requires every property; this result leaves `note` optional.
const looseReport = schema({
  type: "object",
  properties: { count: { type: "number" }, note: { type: "string" } },
  required: ["count"],
  additionalProperties: false,
});
const strictReport = schema({
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
  additionalProperties: false,
});
const typed = (model: AgentModel, resultSchema: StandardSchemaV1<unknown>) =>
  defineAgent({
    id: "typed-provider",
    environment: remote(),
    inputSchema: files,
    task: () => "Count",
    resultSchema,
    model,
  });

afterEach(() => vi.unstubAllGlobals());

describe("model descriptor checks", () => {
  it("passes the compiled descriptors to a model's hook at definition", () => {
    const seen: AgentModelDescriptors[] = [];
    const model: AgentModel = Object.assign(
      () => ({ decision: { kind: "finish", result: { count: 1 } }, conversation: null }),
      { checkDescriptors: (descriptors: AgentModelDescriptors) => void seen.push(descriptors) }
    );
    defineAgent({ id: "hooked", model, defaultTools: ["read"], codemode: false });
    expect(seen[0]!.capabilities.map(({ name }) => name)).toEqual(["read"]);
    expect(seen[0]!.resultJsonSchema).toMatchObject({ properties: { answer: { type: "string" } } });
    typed(model, strictReport);
    expect(seen[1]!.resultJsonSchema).toMatchObject({ required: ["count"] });
    defineAgent({ id: "hooked-codemode", model, codemode: true });
    expect(seen[2]!.capabilities.map(({ name }) => name)).toEqual(["codemode"]);
  });

  it("rejects an OpenAI-incompatible result schema at definition without any request", () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    expect(() => typed(openaiModel({ apiKey: "fixture" }), looseReport)).toThrow(
      expect.objectContaining({
        code: "TUBELESS_AGENT_INVALID_DEFINITION",
        message:
          "Agent typed-provider cannot use its model: OpenAI strict schema at tool _finish must require every property exactly once",
      })
    );
    expect(() => typed(openaiModel({ apiKey: "fixture" }), strictReport)).not.toThrow();
    // A model without the hook defers the same check to its first request.
    expect(() => typed(() => ({ decision: null, conversation: null }), looseReport)).not.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces Anthropic's strict tool limit at definition", () => {
    const tool = defineTool({
      description: "Noop",
      inputSchema: schema({ type: "object", properties: {}, additionalProperties: false }),
      outputSchema: schema({}),
      run: () => null,
    });
    const tools = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`t${index}`, tool]));
    const define = (strict: boolean) =>
      defineAgent({ id: "many", tools, model: anthropicModel({ apiKey: "fixture", strict }) });
    // Six default tools, fourteen custom tools and _finish make 21.
    expect(() => define(true)).toThrow("Anthropic strict mode allows at most 20 tools per request");
    expect(() => define(false)).not.toThrow();
    expect(() =>
      defineAgent({
        id: "few",
        tools,
        defaultTools: ["read"],
        model: anthropicModel({ apiKey: "fixture" }),
      })
    ).not.toThrow();
  });
});
