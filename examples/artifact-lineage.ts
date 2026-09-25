import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSteps, definePipeline, type ArtifactLoader, type ArtifactSaver } from "tubeless";
import { writeJson } from "tubeless/node";

interface Options {
  source: string;
  destination: string;
}

// Adapters remain application-owned and can be reused by other pipelines.
const readLines: ArtifactLoader<string, readonly string[], Options> = async (filename, context) => {
  const path = resolve(context.cwd, filename);
  const text = await readFile(path, { encoding: "utf8", signal: context.signal });
  return {
    value: text.split(/\r?\n/),
    artifact: {
      uri: pathToFileURL(path).href,
      mediaType: "text/plain",
      checksum: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      byteSize: Buffer.byteLength(text),
    },
  };
};

const saveRows: ArtifactSaver<readonly string[], { path: string; rowCount: number }, Options> = (
  rows,
  context
) => {
  context.signal?.throwIfAborted();
  const path = resolve(context.cwd, context.options.destination);
  // This synchronous atomic helper cannot be interrupted once started.
  writeJson(path, rows);
  return {
    value: { path, rowCount: rows.length },
    artifact: { uri: pathToFileURL(path).href, mediaType: "application/json" },
  };
};

const { loadArtifact, step, saveArtifact } = createSteps<Options>();
const load = loadArtifact("load", {
  description: "Read source lines and record their location and checksum.",
  load: (_inputs, context) => readLines(context.options.source, context),
});
const normalize = step("normalize", {
  dependsOn: [load],
  run: ({ load: rows }) => rows.map((row) => row.trim().toLowerCase()).filter(Boolean),
});
const save = saveArtifact("save", {
  dependsOn: [normalize],
  description: "Write normalized rows with a traceable artifact identity.",
  save: ({ normalize: rows }, context) => saveRows(rows, context),
  // Without this handler, the saver would be skipped during a dry run.
  dryRun: ({ normalize: rows }, context) => {
    const path = resolve(context.cwd, context.options.destination);
    return {
      value: { path, rowCount: rows.length },
      artifact: { uri: pathToFileURL(path).href, mediaType: "application/json" },
    };
  },
});

export const ArtifactLineagePipeline = definePipeline({
  id: "artifact-lineage",
  name: "Artifact lineage",
  steps: [load, normalize, save],
  finalize: save,
});
