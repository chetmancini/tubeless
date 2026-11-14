import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, writeModule } from "../workbench.test-support.js";

beforeEach(() => {
  for (const key of ["BASETEN_API_KEY", "BASETEN_MODEL", "BASETEN_BASE_URL"])
    vi.stubEnv(key, undefined);
  // Unrelated public-service configuration must not influence a configured service.
  vi.stubEnv("OPENAI_API_KEY", "unrelated-openai-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "unrelated-anthropic-key");
  vi.stubEnv("OPENAI_MODEL", "unrelated-openai-model");
  vi.stubEnv("ANTHROPIC_MODEL", "unrelated-anthropic-model");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://unrelated.example");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const example = resolve("examples/agent-providers.ts");

function mockMessages() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "finish", name: "_finish", input: { result: { answer: "Done." } } },
      ],
    })
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("named agent provider registries", () => {
  it("resolves the default name through the supplied registry without public-service defaults", async () => {
    const { directory } = await writeModule(`
      export default { openai: {
        model: "private-default",
        createModel: ({model}) => () => ({decision: {kind: "finish", result: {answer: model}}, conversation: null}),
      } };
    `);
    const fetcher = mockMessages();
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(["agent", "--model-module", "pipeline.mjs", "--prompt", "hi"], io)
    ).toBe(0);
    expect(io.output.join("")).toContain("private-default");
    expect(io.output.join("")).not.toContain("unrelated-openai-model");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { envModel: undefined, cliModel: undefined, expected: "deepseek-ai/DeepSeek-V4.1-Flash-1017" },
    { envModel: "configured-model", cliModel: undefined, expected: "configured-model" },
    { envModel: "configured-model", cliModel: "selected-model", expected: "selected-model" },
  ])(
    "runs the compiled Baseten recipe with model precedence: %j",
    async ({ envModel, cliModel, expected }) => {
      const { directory } = await writeModule("");
      vi.stubEnv("BASETEN_MODEL", envModel);
      await writeFile(join(directory, ".env.agent"), "BASETEN_API_KEY=scoped-key\n");
      const fetcher = mockMessages();
      const io = captureIo(directory);
      expect(
        await runWorkbenchCli(
          [
            "agent",
            "--model-module",
            example,
            "--provider",
            "baseten",
            "--env-file",
            ".env.agent",
            "--prompt",
            "hi",
            ...(cliModel ? ["--model", cliModel] : []),
          ],
          io
        )
      ).toBe(0);
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe("https://inference.baseten.co/v1/messages");
      const headers = new Headers(init!.headers);
      expect(headers.get("authorization")).toBe("Bearer scoped-key");
      expect(headers.has("x-api-key")).toBe(false);
      const payload = JSON.parse(init!.body as string);
      expect(payload.model).toBe(expected);
      expect(typeof payload.system).toBe("string");
      expect(payload).not.toHaveProperty("cache_control");
      expect(payload).not.toHaveProperty("compaction");
      expect(payload.tools.every((tool: { strict?: boolean }) => tool.strict === undefined)).toBe(
        true
      );
      expect(io.errors).toEqual([]);
      expect(io.output.join("")).not.toContain("scoped-key");
      expect(process.env.BASETEN_API_KEY).toBeUndefined();
    }
  );

  it("checks only the selected configuration's credentials before opening a REPL", async () => {
    const fetcher = mockMessages();
    const io = { ...captureIo("/tmp"), stdin: Readable.from(["hi\n"]) };
    expect(
      await runWorkbenchCli(["agent", "--model-module", example, "--provider", "baseten"], io)
    ).toBe(1);
    expect(io.errors.join("")).toContain("export BASETEN_API_KEY");
    expect(io.output).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("routes a configured service to its own gateway", async () => {
    vi.stubEnv("BASETEN_API_KEY", "gateway-key");
    vi.stubEnv("BASETEN_BASE_URL", "https://private.example/prefix");
    const fetcher = mockMessages();
    const { directory } = await writeModule("");
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--model-module", example, "--provider", "baseten", "--prompt", "hi"],
        io
      )
    ).toBe(0);
    expect(fetcher.mock.calls[0]![0]).toBe("https://private.example/prefix/v1/messages");
  });

  it("supports an arbitrary API factory without running unused providers or reading their credentials", async () => {
    const { directory } = await writeModule(`
      export default {
        unused: { model: "unused", credentialEnv: ["UNSET_REQUIRED_KEY"], createModel: () => { throw new Error("unused factory ran"); } },
        local: { model: "local-default", createModel: ({ model, env, signal }) => {
          if (!Object.isFrozen(env) || signal.aborted) throw new Error("incorrect factory context");
          return (request) => ({decision: {kind: "finish", result: {answer: model + ":" + (request.conversation ?? "fresh")}}, conversation: request.task});
        } },
      };
    `);
    const fetcher = mockMessages();
    const io = {
      ...captureIo(directory),
      stdin: Readable.from(["first\n/model other\nsecond\n/clear\nthird\n"]),
    };
    expect(
      await runWorkbenchCli(["agent", "--model-module", "pipeline.mjs", "--provider", "local"], io)
    ).toBe(0);
    expect(io.output.join("")).toContain("local-default:fresh");
    expect(io.output.join("")).toContain("other:first");
    expect(io.output.join("")).toContain("other:fresh");
    expect(fetcher).not.toHaveBeenCalled();
    expect(io.errors).toEqual([]);
  });

  it.each(["openai", "anthropic", "constructor", "toString", "__proto__"])(
    "rejects missing registry entry %s without falling back to a public service",
    async (name) => {
      const fetcher = mockMessages();
      const io = captureIo("/tmp");
      expect(
        await runWorkbenchCli(
          ["agent", "--model-module", example, "--provider", name, "--prompt", "hi"],
          io
        )
      ).toBe(1);
      expect(io.errors.join("")).toContain("Unknown agent provider");
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each([
    "null",
    "[]",
    "{ model: '' , createModel: () => {} }",
    "{ model: 'test' }",
    "{ model: 'test', createModel: () => {}, modelEnv: 'invalid-name' }",
    "{ model: 'test', createModel: () => {}, credentialEnv: 'KEY' }",
    "{ model: 'test', createModel: () => {}, credentialEnv: ['KEY', ''] }",
  ])("rejects malformed configuration %s before model I/O", async (entry) => {
    const { directory } = await writeModule(`export default { test: ${entry} };`);
    const fetcher = mockMessages();
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--model-module", "pipeline.mjs", "--provider", "test", "--prompt", "hi"],
        io
      )
    ).toBe(1);
    expect(io.errors.join("")).toContain("Agent provider must declare");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
