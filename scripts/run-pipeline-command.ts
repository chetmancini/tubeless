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
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: Error;
  }>((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal, spawnError });
    });
  });
  const stderrLines: string[] = [];
  const [outcome] = await Promise.all([
    completion,
    logLines(child.stdout, (line) => context.log.log(line)),
    logLines(child.stderr, (line) => stderrLines.push(line)),
  ]);
  const writeStderr =
    outcome.code === 0 && !outcome.spawnError ? context.log.log : context.log.error;
  for (const line of stderrLines) writeStderr(line);
  if (outcome.spawnError) throw outcome.spawnError;
  if (outcome.code !== 0) {
    throw new Error(
      outcome.signal === null
        ? `${rendered} exited with code ${outcome.code ?? "unknown"}`
        : `${rendered} was terminated by ${outcome.signal}`
    );
  }
}
