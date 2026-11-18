import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pipeline, PipelineStepOutputObserver } from "tubeless";
import { v8StepCacheCodec, writeJson } from "tubeless/node";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Application-owned format; do not share a directory between concurrent execution owners. */
export async function openRecoveryStore<TStepId extends string>(
  directory: string,
  pipeline: Pick<Pipeline<object, unknown, TStepId>, "id" | "definition" | "stepIds">,
  execution: { executionId: string; inputIdentity: string }
) {
  const identity = pipeline.definition?.identity;
  if (!identity?.implementationVersion)
    throw new Error("Recovery requires an explicit implementationVersion");
  const scope = {
    formatVersion: 1,
    executionId: execution.executionId,
    inputIdentity: execution.inputIdentity,
    pipelineId: pipeline.id,
    identityVersion: identity.version,
    definitionId: identity.definitionId,
    structuralFingerprint: identity.structuralFingerprint,
    implementationVersion: identity.implementationVersion,
    codecIdentity: `v8:${process.versions.v8}:bun:${process.versions.bun ?? "none"}`,
  };
  const stepIds = [...pipeline.stepIds];
  const fileFor = (stepId: TStepId) =>
    join(directory, `${createHash("sha256").update(stepId).digest("hex")}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const observer: PipelineStepOutputObserver<TStepId> = {
    encode: v8StepCacheCodec.encode,
    write(record, { signal }) {
      signal?.throwIfAborted();
      if (
        record.pipelineId !== scope.pipelineId ||
        record.definitionIdentity.definitionId !== scope.definitionId ||
        !stepIds.includes(record.stepId)
      )
        throw new Error("Output record belongs to another pipeline definition");
      // writeJson atomically replaces one complete file, then returns acknowledgement.
      writeJson(fileFor(record.stepId), {
        scope,
        stepId: record.stepId,
        encodedValue: Buffer.from(record.encodedValue).toString("base64"),
      });
    },
  };

  return {
    observer,
    async load(): Promise<Map<TStepId, unknown>> {
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
      const entries = await Promise.all(
        files.map(async (file) => {
          const saved: unknown = JSON.parse(await readFile(join(directory, file), "utf8"));
          const stepId = isRecord(saved) ? stepIds.find((id) => id === saved.stepId) : undefined;
          const savedScope = isRecord(saved) ? saved.scope : undefined;
          if (
            stepId === undefined ||
            !isRecord(saved) ||
            !isRecord(savedScope) ||
            !Object.entries(scope).every(([key, value]) => savedScope[key] === value) ||
            fileFor(stepId) !== join(directory, file) ||
            typeof saved.encodedValue !== "string"
          )
            throw new Error("Saved output is incompatible or malformed");
          // Decode fresh objects per invocation, only after checking host compatibility.
          return [
            stepId,
            await v8StepCacheCodec.decode(Buffer.from(saved.encodedValue, "base64")),
          ] as const;
        })
      );
      return new Map(entries);
    },
  };
}
