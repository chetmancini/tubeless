import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runWorkbenchCli } from "../workbench.js";
import { captureIo, writeModule } from "../workbench.test-support.js";
import { createTerminalTextStream } from "./text-stream.js";

describe("agent terminal streaming", () => {
  it.each([false, true])(
    "forwards opt-in streams to factories without enabling capture (stream=%s)",
    async (enabled) => {
      const { directory } = await writeModule(`
      export default ({ text }) => async () => {
        if (text) {
          const identity = { streamId: "fixture", provider: "openai", turn: 1 };
          await text.write({ ...identity, kind: "delta", text: "Hello " });
          await text.write({ ...identity, kind: "delta", text: "world\\u001b[2J" });
          await text.write({ ...identity, kind: "end", status: "completed" });
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
    const identity = { streamId: "fixture", provider: "openai" as const, turn: 1 };
    let delivered = false;
    const writing = Promise.resolve(
      text.write({ ...identity, kind: "delta", text: "partial" })
    ).then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    flush();
    await writing;
    const ending = text.write({ ...identity, kind: "end", status: "interrupted" });
    flush();
    await ending;
    expect(output.join("")).toBe("\nassistant · partial\n[assistant text interrupted]\n");
    stderr.destroy();
  });
});
