import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import type { WorkbenchCliIo } from "../workbench-shared.js";

export type RemoteProcess = (request: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  interactive?: boolean;
  output?: WorkbenchCliIo["stderr"];
}) => Promise<string>;

const runRemoteProcess: RemoteProcess = async ({
  command,
  args,
  cwd,
  env,
  signal,
  interactive,
  output,
}) => {
  if (!interactive) {
    const { stdout } = await promisify(execFile)(command, [...args], {
      cwd,
      env,
      signal,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000,
    });
    return stdout;
  }
  const child = spawn(command, [...args], {
    cwd,
    env,
    signal,
    stdio: ["inherit", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.setEncoding("utf8").on("data", (chunk: string) => output?.write(chunk));
  const [code]: unknown[] = await once(child, "close");
  if (code !== 0)
    throw new Error(
      `${command} exited with ${typeof code === "number" ? code : "an interruption"}.`
    );
  return "";
};

export type RemoteProcessContext = {
  io: WorkbenchCliIo;
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  execute?: RemoteProcess;
};

export function remoteProcess(context: RemoteProcessContext) {
  return (
    command: string,
    args: readonly string[],
    options?: {
      interactive?: boolean;
      env?: Record<string, string>;
    }
  ) =>
    (context.execute ?? runRemoteProcess)({
      command,
      args,
      cwd: context.io.cwd,
      env: { ...context.env, ...options?.env },
      signal: context.signal,
      interactive: options?.interactive,
      output: context.io.stderr,
    });
}
