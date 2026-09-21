import { describe, expect, it } from "vitest";
import { runPipelineCommand } from "./run-pipeline-command.ts";

describe("runPipelineCommand", () => {
  it("waits for an aborted subprocess to close and drain its output", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const childProgram = `
      process.on("SIGTERM", () => {
        setTimeout(() => {
          process.stdout.write("closed\\n");
          process.exit(0);
        }, 50);
      });
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `;

    const result = runPipelineCommand(process.execPath, ["--eval", childProgram], {
      cwd: process.cwd(),
      signal: controller.signal,
      log: {
        error: (message) => lines.push(String(message)),
        log: (message) => {
          const line = String(message);
          lines.push(line);
          if (line === "ready") controller.abort();
        },
        warn: (message) => lines.push(String(message)),
      },
    });

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(lines).toContain("closed");
  });
});
