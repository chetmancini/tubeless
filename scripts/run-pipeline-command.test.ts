import { describe, expect, it } from "vitest";
import { runPipelineCommand } from "./run-pipeline-command.ts";

describe("runPipelineCommand", () => {
  it.each([
    { exitCode: 0, expectedLevel: "log" },
    { exitCode: 3, expectedLevel: "error" },
  ] as const)(
    "classifies stderr after exit code $exitCode",
    async ({ exitCode, expectedLevel }) => {
      const messages = { log: [] as string[], error: [] as string[] };
      const result = runPipelineCommand(
        process.execPath,
        ["--eval", `process.stderr.write("diagnostic\\n"); process.exit(${exitCode})`],
        {
          cwd: process.cwd(),
          signal: new AbortController().signal,
          log: {
            log: (message) => messages.log.push(String(message)),
            error: (message) => messages.error.push(String(message)),
            warn: () => {},
          },
        }
      );

      if (exitCode === 0) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("exited with code 3");
      expect(messages[expectedLevel]).toContain("diagnostic");
      expect(messages[expectedLevel === "log" ? "error" : "log"]).not.toContain("diagnostic");
    }
  );

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
