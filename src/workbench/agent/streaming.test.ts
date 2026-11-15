import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, writeModule } from "../workbench.test-support.js";
import { readAgentText } from "../../agent/text-stream.js";
import { createTerminalTextStream } from "./text-stream.js";

describe("agent terminal streaming", () => {
  it.each([false, true])(
    "forwards opt-in streams to factories without enabling capture (stream=%s)",
    async (enabled) => {
      const { directory } = await writeModule(`
      export default ({ text, signal }) => async () => {
        if (text) {
          const identity = { streamId: "fixture", provider: "openai", turn: 1 };
          await text({ ...identity, kind: "delta", text: "Hello " }, signal);
          await text({ ...identity, kind: "delta", text: "world\\u001b[2J" }, signal);
          await text({ ...identity, kind: "end", status: "completed" }, signal);
        }
        return { conversation: null, decision: { kind: "finish", result: { answer: "Final answer" } } };
      };
    `);
      const io = captureIo(directory);
      expect(
        await runWorkbenchCli(
          [
            "agent",
            "--model-module",
            "pipeline.mjs",
            "--store",
            "runs.sqlite",
            "--prompt",
            "hello",
            ...(enabled ? ["--stream"] : []),
          ],
          io
        )
      ).toBe(0);
      const stderr = io.errors.join("");
      expect(stderr).toBe(enabled ? "\nassistant · Hello world\n" : "");
      expect(io.output.join("")).toContain("Final answer");
      expect(io.output.join("")).not.toContain("Hello world");
      expect(stderr).not.toContain("\u001b");
      const listing = captureIo(directory);
      expect(
        await runWorkbenchCli(
          ["history", "--store", "runs.sqlite", "--pipeline", "tubeless-agent", "--json"],
          listing
        )
      ).toBe(0);
      const saved = JSON.parse(listing.output.join(""));
      const detail = captureIo(directory);
      expect(
        await runWorkbenchCli(
          ["history", "--store", "runs.sqlite", "--json", saved.runs[0].runId],
          detail
        )
      ).toBe(0);
      expect(JSON.parse(detail.output.join(""))).not.toHaveProperty("transcript");
    }
  );

  it("awaits output flush and labels an interrupted attempt without printing its final body", async () => {
    let flush!: (error?: Error | null) => void;
    const output: string[] = [];
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        output.push(String(chunk));
        flush = callback;
      },
    });
    const io = { ...captureIo("/tmp"), stderr };
    const text = createTerminalTextStream(io);
    const signal = new AbortController().signal;
    const identity = { streamId: "fixture", provider: "openai" as const, turn: 1 };
    let delivered = false;
    const writing = Promise.resolve(
      text({ ...identity, kind: "delta", text: "partial" }, signal)
    ).then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    flush();
    await writing;
    const ending = text({ ...identity, kind: "end", status: "interrupted" }, signal);
    flush();
    await ending;
    expect(output.join("")).toBe("\nassistant · partial\n[assistant text interrupted]\n");
    stderr.destroy();
  });
  it("releases flush listeners after repeated prompt cancellation while the launch remains active", async () => {
    const stderr = new Writable({ write(_chunk, _encoding, _callback) {} });
    const launch = new AbortController();
    const sink = createTerminalTextStream({ ...captureIo("/tmp"), stderr, signal: launch.signal });
    try {
      for (let index = 0; index < 8; index++) {
        const prompt = new AbortController();
        const writing = readAgentText(
          new Response(null),
          async (_events, write) => {
            await write("partial");
            return {};
          },
          "openai",
          1,
          sink,
          prompt.signal
        );
        expect(stderr.listenerCount("error")).toBe(1);
        prompt.abort();
        await expect(writing).rejects.toThrow();
        expect(stderr.listenerCount("error")).toBe(0);
        expect(stderr.listenerCount("close")).toBe(0);
      }
      expect(launch.signal.aborted).toBe(false);
    } finally {
      stderr.destroy();
    }
  });
  it("keeps sanitizer state per stream for split CSI and OSC sequences", async () => {
    const io = captureIo("/tmp");
    const text = createTerminalTextStream(io);
    const signal = new AbortController().signal;
    const identity = { streamId: "fixture", provider: "openai" as const, turn: 1 };
    for (const chunk of ["\u001B[", "31mred", "\u001B]private title", "\u001B", "\\after"]) {
      await text({ ...identity, kind: "delta", text: chunk }, signal);
    }
    await text({ ...identity, kind: "end", status: "completed" }, signal);
    await text({ ...identity, kind: "delta", text: "fresh" }, signal);
    await text({ ...identity, kind: "end", status: "completed" }, signal);
    expect(io.errors.join("")).toBe("\nassistant · redafter\n\nassistant · fresh\n");
  });
});
