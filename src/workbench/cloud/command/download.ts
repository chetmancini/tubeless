import { link, lstat, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { errorMessage, shellWord } from "../../workbench-shared.js";
import { CloudClientError } from "../protocol.js";
import type { CloudContext } from "../shared.js";

export type DownloadAction =
  | { kind: "download"; runId: string; path: string; name: string }
  | { kind: "manifest"; runId: string; path: string };

export async function downloadRunFile(
  context: CloudContext,
  action: DownloadAction
): Promise<void> {
  const { client, workspace, io, output, signal } = context;
  const destination = resolve(io.cwd, action.path);
  const temp = join(dirname(destination), `.${crypto.randomUUID()}.tmp`);
  const failSave = (error: unknown): never => {
    throw new CloudClientError(
      `Could not save Cloud download to ${destination}: ${errorMessage(error)}`,
      "local_io_error"
    );
  };
  const outputExists = () =>
    new CloudClientError(`Output already exists: ${destination}`, "local_io_error");

  signal.throwIfAborted();
  const existing = await lstat(destination).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failSave(error);
  });
  if (existing) throw outputExists();
  const file = await open(temp, "wx", 0o600).catch(failSave);
  try {
    const write = (bytes: Uint8Array) => file.writeFile(bytes).catch(failSave);
    try {
      if (action.kind === "download")
        await client.downloadArtifact(workspace, action.runId, action.name, write);
      else await write(await client.getManifest(workspace, action.runId));
    } finally {
      await file.close().catch(failSave);
    }
    signal.throwIfAborted();
    // Linking publishes the complete file and fails if a concurrent writer won.
    await link(temp, destination).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw outputExists();
      failSave(error);
    });
  } finally {
    await unlink(temp).catch((error: unknown) => {
      io.stderr.write(
        `Could not remove temporary download ${output.text(temp)}: ${output.text(errorMessage(error))}\n`
      );
    });
  }

  const displayPath = output.text(destination);
  io.stderr.write(`Saved ${displayPath}\n`);
  if (action.kind === "manifest") {
    const argument = displayPath === destination ? shellWord(destination) : "<manifest-file>";
    io.stderr.write(`To reproduce locally: tubeless cloud reproduce --execute ${argument}\n`);
  }
}
