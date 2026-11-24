import { link, lstat, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { errorMessage, shellWord } from "../../workbench-shared.js";
import type { ObservationContext } from "../follow.js";
import { CloudClientError } from "../protocol.js";
import { formatArtifact } from "./inspect.js";

export type DownloadAction =
  | { kind: "download"; runId: string; path: string; name: string }
  | { kind: "manifest"; runId: string; path: string };

export async function listArtifacts(context: ObservationContext, runId: string): Promise<number> {
  const { client, workspace, io, json, output } = context;
  const { artifacts } = await client.getRun(workspace, runId);
  if (json) io.stdout.write(`${output.json(artifacts)}\n`);
  else if (artifacts.length === 0) io.stdout.write("No retained artifacts.\n");
  else
    io.stdout.write(
      artifacts.map((artifact) => formatArtifact(artifact, output.text)).join("\n") + "\n"
    );
  return 0;
}

function fileExists(path: string) {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  );
}

export async function downloadRunFile(
  context: ObservationContext,
  action: DownloadAction
): Promise<number> {
  const { client, workspace, io, output, signal } = context;
  const destination = resolve(io.cwd, action.path);
  const temp = join(dirname(destination), `.${crypto.randomUUID()}.tmp`);
  const saveError = (error: unknown) =>
    new CloudClientError(
      `Could not save Cloud download to ${destination}: ${errorMessage(error)}`,
      "local_io_error"
    );
  try {
    signal.throwIfAborted();
    if (await fileExists(destination))
      throw new CloudClientError(`Output already exists: ${destination}`, "local_io_error");
    const file = await open(temp, "wx", 0o600);
    try {
      try {
        if (action.kind === "download")
          await client.downloadArtifact(workspace, action.runId, action.name, (bytes) =>
            file.writeFile(bytes).catch((error: unknown) => {
              throw saveError(error);
            })
          );
        else await file.writeFile(await client.getManifest(workspace, action.runId));
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      // Linking publishes the complete file and fails if a concurrent writer won.
      await link(temp, destination);
    } finally {
      await unlink(temp).catch((error: unknown) => {
        io.stderr.write(
          `Could not remove temporary download ${output.text(temp)}: ${output.text(errorMessage(error))}\n`
        );
      });
    }
  } catch (error) {
    if (error instanceof CloudClientError || signal.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CloudClientError(`Output already exists: ${destination}`, "local_io_error");
    throw saveError(error);
  }

  const displayPath = output.text(destination);
  io.stderr.write(`Saved ${displayPath}\n`);
  if (action.kind === "manifest") {
    const argument = displayPath === destination ? shellWord(destination) : "<manifest-file>";
    io.stderr.write(`To reproduce locally: tubeless cloud reproduce --execute ${argument}\n`);
  }
  return 0;
}
