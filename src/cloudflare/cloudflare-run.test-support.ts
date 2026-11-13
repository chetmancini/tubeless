import { vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "../core/pipeline.js";
import { defineProject } from "../project/project.js";
import { hostedProjectCommands } from "../hosting/hosting-commands.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { RunJob, StudioIngest } from "./cloudflare-run-contract.js";

function schema<T>(validate: (value: unknown) => T | undefined): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      vendor: "test",
      version: 1,
      validate: (value) => {
        const result = validate(value);
        return result === undefined
          ? { issues: [{ message: "Expected at least 3 characters" }] }
          : { value: result };
      },
      jsonSchema: { input: () => ({ type: "object", properties: { name: { type: "string" } } }) },
    } as StandardSchemaV1<T, T>["~standard"],
  };
}
const nameSchema = schema((value) => {
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.length >= 3 ? { name } : undefined;
});
const { step } = createSteps(nameSchema);
const greet = step("greet", { run: (_inputs, context) => `hi ${context.options.name}` });
const Greeting = definePipeline({ id: "greeting", steps: [greet], finalize: greet });
// Blocks until the run is aborted, so tests can exercise cancellation and the deadline.
const hold = step("hold", {
  run: (_inputs, context) =>
    new Promise<never>((_resolve, reject) => {
      const signal = context.signal;
      if (!signal) return reject(new Error("The run has no abort signal."));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
});
const Waiting = definePipeline({ id: "waiting", steps: [hold], finalize: hold });
export const sideEffect = vi.fn();
const effect = step("effect", { run: () => void sideEffect() });
const Effect = definePipeline({ id: "effect", steps: [effect], finalize: effect });
const noisy = step("noisy", { run: (_inputs, context) => context.log.log("x".repeat(3_000_000)) });
const Noisy = definePipeline({ id: "noisy", steps: [noisy], finalize: noisy });
export const commands = new Map(
  hostedProjectCommands(defineProject("p", [Greeting, Waiting, Effect, Noisy])).map((entry) => [
    entry.descriptor.id,
    entry,
  ])
);
export function ingest(admit: StudioIngest["admit"] = async () => ({ admitted: true })) {
  const batches: { sequence: number; events: PipelineTraceEvent[] }[] = [];
  const failures: string[] = [];
  const studio: StudioIngest = {
    admit,
    appendEvents: async (_launchId, sequence, events) => {
      batches.push({ sequence, events });
      return { accepted: true };
    },
    reportFailure: async (_launchId, message) => void failures.push(message),
  };
  return { studio, batches, failures };
}
export const job = (values: Record<string, unknown>): RunJob => ({
  launchId: "l1",
  commandId: "greeting",
  values,
  maxRunDurationMs: 60_000,
});

export const completedStatus = (batches: { events: PipelineTraceEvent[] }[]) =>
  batches.flatMap((batch) => batch.events).find((event) => event.name === "pipeline.completed")
    ?.payload;
