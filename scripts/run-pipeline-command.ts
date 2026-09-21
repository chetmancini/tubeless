import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { PipelineStepContext } from "tubeless";

type CommandContext = Pick<PipelineStepContext<object>, "cwd" | "log" | "signal">;

function logLines(stream: Readable, write: (line: string) => void): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on("line", write);
  return new Promise((resolve) => lines.once("close", resolve));
}

function displayCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((value) => (/^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(" ");
}

/** Run one repository command while retaining its output in pipeline logs and traces. */
export async function runPipelineCommand(
  command: string,
  args: readonly string[],
  context: CommandContext
): Promise<void> {
  const rendered = displayCommand(command, args);
  context.log.log(`$ ${rendered}`);

  const child = spawn(command, args, {
    cwd: context.cwd,
    signal: context.signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise<void>((resolve, reject) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `${rendered} exited with code ${code ?? "unknown"}`
            : `${rendered} was terminated by ${signal}`
        )
      );
    });
  });
  await Promise.all([
    completion,
    logLines(child.stdout, (line) => context.log.log(line)),
    logLines(child.stderr, (line) => context.log.error(line)),
  ]);
}
