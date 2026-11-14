import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, writeModule } from "../workbench.test-support.js";

beforeEach(() => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_BASE_URL",
  ])
    vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mockAnthropic() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "finish",
          name: "_finish",
          input: { result: { answer: "Ready." } },
        },
      ],
      stop_reason: "tool_use",
    })
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("agent provider selection", () => {
  it.each([undefined, "", " \t\n"])(
    "checks Anthropic credentials before starting with key %j",
    async (key) => {
      vi.stubEnv("ANTHROPIC_API_KEY", key);
      vi.stubEnv("OPENAI_API_KEY", "unrelated-key");
      const fetcher = mockAnthropic();
      const io = { ...captureIo("/tmp"), stdin: Readable.from(["hi\n"]) };
      expect(await runWorkbenchCli(["agent", "--provider", "anthropic"], io)).toBe(1);
      expect(io.errors.join("")).toContain("export ANTHROPIC_API_KEY");
      expect(io.errors.join("")).toContain("--env-file");
      expect(io.output).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])(
    "rejects whitespace in %s without exposing it",
    async (name) => {
      vi.stubEnv(name, "private-key\nsecond-line");
      const fetcher = mockAnthropic();
      const io = captureIo("/tmp");
      expect(
        await runWorkbenchCli(["agent", "--provider", "anthropic", "--prompt", "hi"], io)
      ).toBe(1);
      expect(io.errors.join("")).toContain(`${name} must be a single token`);
      expect(io.errors.join("")).not.toContain("private-key");
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each([
    { credential: "ANTHROPIC_API_KEY", header: "x-api-key", expected: "fixture" },
    { credential: "ANTHROPIC_AUTH_TOKEN", header: "authorization", expected: "Bearer fixture" },
  ])(
    "uses the Anthropic default model and $credential without OpenAI credentials",
    async ({ credential, header, expected }) => {
      vi.stubEnv(credential, " fixture ");
      vi.stubEnv("OPENAI_MODEL", "unrelated-model");
      vi.stubEnv("OPENAI_BASE_URL", "https://unrelated.example");
      const fetcher = mockAnthropic();
      const { directory } = await writeModule("");
      const io = captureIo(directory);
      expect(
        await runWorkbenchCli(["agent", "--provider", "anthropic", "--prompt", "hi"], io)
      ).toBe(0);
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = new Headers(init!.headers);
      expect(headers.get(header)).toBe(expected);
      expect(headers.has(header === "x-api-key" ? "authorization" : "x-api-key")).toBe(false);
      expect(JSON.parse(init!.body as string).model).toBe("claude-opus-5-5");
      expect(io.output.join("")).toContain("Ready.");
      expect(io.errors).toEqual([]);
    }
  );

  it.each([
    {
      inherited: false,
      cliModel: undefined,
      expectedModel: "file-model",
      expectedKey: "file-key",
      expectedBase: "https://file.example",
    },
    {
      inherited: true,
      cliModel: undefined,
      expectedModel: "process-model",
      expectedKey: "process-key",
      expectedBase: "https://process.example",
    },
    {
      inherited: true,
      cliModel: "selected-model",
      expectedModel: "selected-model",
      expectedKey: "process-key",
      expectedBase: "https://process.example",
    },
  ])(
    "resolves Anthropic dotenv, process and CLI precedence: %j",
    async ({ inherited, cliModel, expectedModel, expectedKey, expectedBase }) => {
      if (inherited) {
        vi.stubEnv("ANTHROPIC_API_KEY", " process-key ");
        vi.stubEnv("ANTHROPIC_MODEL", "process-model");
        vi.stubEnv("ANTHROPIC_BASE_URL", "https://process.example");
      }
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "lower-priority-token");
      const { directory } = await writeModule("");
      await writeFile(
        join(directory, ".env.agent"),
        "ANTHROPIC_API_KEY=file-key\nANTHROPIC_MODEL=file-model\nANTHROPIC_BASE_URL=https://file.example\n"
      );
      const fetcher = mockAnthropic();
      const io = captureIo(directory);
      expect(
        await runWorkbenchCli(
          [
            "agent",
            "--provider",
            "anthropic",
            "--env-file",
            ".env.agent",
            "--prompt",
            "hi",
            ...(cliModel ? ["--model", cliModel] : []),
          ],
          io
        )
      ).toBe(0);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe(`${expectedBase}/v1/messages`);
      expect(new Headers(init!.headers).get("x-api-key")).toBe(expectedKey);
      expect(JSON.parse(init!.body as string).model).toBe(expectedModel);
      expect(process.env.ANTHROPIC_API_KEY).toBe(inherited ? " process-key " : undefined);
      expect(io.output.join("") + io.errors.join("")).not.toContain(expectedKey);
    }
  );

  it("loads a bearer token from the scoped dotenv environment", async () => {
    const { directory } = await writeModule("");
    await writeFile(join(directory, ".env.agent"), "ANTHROPIC_AUTH_TOKEN=file-token\n");
    const fetcher = mockAnthropic();
    const io = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["agent", "--provider", "anthropic", "--env-file", ".env.agent", "--prompt", "hi"],
        io
      )
    ).toBe(0);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("authorization")).toBe(
      "Bearer file-token"
    );
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("keeps Anthropic conversation across model changes and clears it on request", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
    const fetcher = mockAnthropic();
    const { directory } = await writeModule("");
    const io = {
      ...captureIo(directory),
      stdin: Readable.from(["first\n/model changed\nsecond\n/clear\nthird\n"]),
    };
    expect(await runWorkbenchCli(["agent", "--provider", "anthropic"], io)).toBe(0);
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies.map(({ model }) => model)).toEqual(["claude-opus-5-5", "changed", "changed"]);
    expect(bodies[0].messages).toEqual([{ role: "user", content: "first" }]);
    expect(bodies[1].messages).toEqual([
      bodies[0].messages[0],
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "finish",
            name: "_finish",
            input: { result: { answer: "Ready." } },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "finish", content: '{"answer":"Ready."}' },
          { type: "text", text: "second" },
        ],
      },
    ]);
    expect(bodies[2].messages).toEqual([{ role: "user", content: "third" }]);
    expect(io.errors).toEqual([]);
  });

  it.each([
    ["--provider", "unknown"],
    ["--provider", " "],
    ["--provider", "anthropic", "--model-module", "missing.ts"],
    ["--provider", "openai", "--model-module", "missing.ts"],
  ])("rejects invalid provider combinations before loading modules: %j", async (...flags) => {
    const fetcher = mockAnthropic();
    const io = captureIo("/tmp");
    expect(await runWorkbenchCli(["agent", "--prompt", "hi", ...flags], io)).toBe(1);
    expect(io.errors.join("")).toContain("Usage: tubeless agent");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
