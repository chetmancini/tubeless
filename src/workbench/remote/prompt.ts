import { createInterface } from "node:readline/promises";
import { terminalSafeText, type WorkbenchCliIo } from "../workbench-shared.js";

export type RemotePrompt = (label: string) => Promise<string>;

export function remotePrompt(io: WorkbenchCliIo, signal: AbortSignal): RemotePrompt {
  const input = io.stdin;
  return async (label) => {
    if (!input?.isTTY)
      throw new Error("This choice requires a terminal. See tubeless remote --help for flags.");
    const terminal = createInterface({ input });
    try {
      io.stderr.write(label);
      return (await terminal.question("", { signal })).trim();
    } finally {
      terminal.close();
    }
  };
}

export async function chooseRemoteOption<T>(
  options: readonly T[],
  description: string,
  label: (option: T) => string,
  ask: RemotePrompt,
  io: WorkbenchCliIo
): Promise<T> {
  if (options.length === 0) throw new Error(`No ${description} found.`);
  if (options.length === 1) return options[0];
  for (const [index, option] of options.entries())
    io.stderr.write(`  ${index + 1}. ${terminalSafeText(label(option))}\n`);
  const answer = await ask(`Choose ${description} (1–${options.length}): `);
  if (!/^[1-9]\d*$/.test(answer) || Number(answer) > options.length)
    throw new Error(`Choose a listed ${description}.`);
  return options[Number(answer) - 1];
}
