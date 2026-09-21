import type {
  PipelineStepContext,
  PipelineStepProgressDetailStatus,
  StandardSchemaV1,
} from "tubeless";
import { runConcurrent } from "tubeless/batch";
import type { ProjectRegistry } from "tubeless/project";
import { withRetry } from "tubeless/retry";

interface Rider {
  id: string;
  kit: string[];
}

interface RaceOptions {
  delay: number;
  concurrency: number;
  failAudit: boolean;
  failTech: boolean;
}

const RIDERS: readonly Rider[] = [
  { id: "cobble", kit: [" Wheels ", "CAGE"] },
  { id: "alpine", kit: ["cassette"] },
  { id: "sprint", kit: ["Tires", "CHAIN"] },
];

function readOptions(value: unknown): RaceOptions {
  if (typeof value !== "object" || value === null) throw new Error("Expected race options");
  const delay = "delay" in value ? value.delay : 300;
  const concurrency = "concurrency" in value ? value.concurrency : 2;
  const failAudit = "failAudit" in value ? value.failAudit : false;
  const failTech = "failTech" in value ? value.failTech : false;
  if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 0 || delay > 2000) {
    throw new Error("delay must be an integer from 0 to 2000");
  }
  if (
    typeof concurrency !== "number" ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  ) {
    throw new Error("concurrency must be an integer from 1 to 8");
  }
  if (typeof failAudit !== "boolean" || typeof failTech !== "boolean") {
    throw new Error("failAudit and failTech must be booleans");
  }
  return { delay, concurrency, failAudit, failTech };
}

function readRiders(value: unknown): Rider[] {
  if (!Array.isArray(value)) throw new Error("Expected riders");
  return value.map((rider: unknown) => {
    if (
      typeof rider !== "object" ||
      rider === null ||
      !("id" in rider) ||
      typeof rider.id !== "string" ||
      !("kit" in rider) ||
      !Array.isArray(rider.kit) ||
      !rider.kit.every((part: unknown) => typeof part === "string")
    ) {
      throw new Error("Expected rider id and string kit items");
    }
    return { id: rider.id, kit: [...rider.kit] };
  });
}

function schema<TInput, TOutput>(
  parse: (value: unknown) => TOutput
): StandardSchemaV1<TInput, TOutput> {
  return {
    "~standard": {
      version: 1,
      vendor: "peloton-example",
      validate(value) {
        try {
          return { value: parse(value) };
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
      },
    },
  };
}

function pause(context: PipelineStepContext<object>) {
  return context.sleep(readOptions(context.options).delay, context.signal);
}

/** All I/O is simulated: the demo never contacts a service or writes a file. */
export const pelotonRegistry: ProjectRegistry = {
  optionsSchemas: { raceOptions: schema<object, RaceOptions>(readOptions) },
  schemas: { riders: schema<unknown, Rider[]>(readRiders) },
  steps: {
    discoverRiders: async (_inputs, context) => {
      for (const [index, rider] of RIDERS.entries()) {
        context.log.log(`sign-on: ${rider.id}`);
        await pause(context);
        context.reportProgress({
          completed: index + 1,
          total: RIDERS.length,
          message: "riders signed on",
        });
      }
      return RIDERS;
    },
    resolveWeather: async (_inputs, context) => {
      context.log.log("reading the simulated weather station");
      await pause(context);
      return "dry";
    },
    previewWeather: (_inputs, context) => {
      context.log.log("using the dry-run forecast");
      return "forecast-dry";
    },
    normalizeBikes: async (inputs, context) => {
      const riders = readRiders(inputs["discover-peloton"]);
      for (const [index, rider] of riders.entries()) {
        rider.kit = rider.kit.map((part) => part.trim().toLowerCase()).filter(Boolean);
        await pause(context);
        context.reportProgress({ completed: index + 1, total: riders.length, message: rider.id });
      }
      return riders;
    },
    inspectBikes: async (inputs, context) => {
      const riders = readRiders(inputs["normalize-bikes"]);
      const { concurrency, delay } = readOptions(context.options);
      // Track actual worker states rather than guessing completion from item order.
      const statuses: PipelineStepProgressDetailStatus[] = riders.map(() => "pending");
      const report = () =>
        context.reportProgress({
          completed: statuses.filter((status) => status === "completed").length,
          total: riders.length,
          message: "bikes inspected",
          details: riders.map((rider, index) => ({
            id: rider.id,
            label: "radio scan",
            status: statuses[index],
          })),
        });
      return runConcurrent(
        riders,
        { concurrency, signal: context.signal },
        async (rider, index) => {
          statuses[index] = "running";
          report();
          try {
            const inspected = await withRetry(
              async ({ attempt }) => {
                context.reportAttempt(attempt, { riderId: rider.id });
                await pause(context);
                if (index === 0 && attempt === 1) {
                  context.log.warn(`race radio drop on ${rider.id}; retrying`);
                  throw new Error("simulated radio drop");
                }
                context.log.log(`scanned ${rider.id}: ${rider.kit.join(", ")}`);
                return rider;
              },
              {
                maxAttempts: 2,
                baseDelayMs: delay,
                jitter: false,
                signal: context.signal,
                sleep: context.sleep,
              }
            );
            statuses[index] = "completed";
            return inspected;
          } catch (error) {
            statuses[index] = context.signal?.aborted ? "cancelled" : "failed";
            throw error;
          } finally {
            report();
          }
        }
      );
    },
    auditCars: async (_inputs, context) => {
      const cars = ["lead-car", "spare-car"];
      for (const [index, car] of cars.entries()) {
        await pause(context);
        context.log.log(`audited ${car}`);
        context.reportProgress({ completed: index + 1, total: cars.length, message: "cars" });
      }
      if (readOptions(context.options).failAudit)
        throw new Error("simulated team-car audit failure");
      return cars.length;
    },
    validateTech: async (inputs, context) => {
      const riders = readRiders(inputs["inspect-bikes"]);
      await pause(context);
      if (readOptions(context.options).failTech || riders.some((rider) => rider.kit.length === 0)) {
        throw new Error("tech validation failed; start list must not be published");
      }
      context.log.log(
        `tech passed for ${riders.length} riders in ${inputs["resolve-weather"]} weather`
      );
      return true;
    },
    publishStartList: async (inputs, context) => {
      const riders = readRiders(inputs["inspect-bikes"]);
      const files = ["start-list.json", "timing.log", "weather.txt"];
      for (const [index, file] of files.entries()) {
        await pause(context);
        context.log.log(`simulated publish: ${file}`);
        context.reportProgress({ completed: index + 1, total: files.length, message: "files" });
      }
      return `start-list-${riders.length}`;
    },
  },
  finalizers: {
    // Partial summaries are valid for this demo, including dry runs and failed audits.
    raceSummary: (outputs) => ({
      riders:
        outputs["discover-peloton"] === undefined
          ? 0
          : readRiders(outputs["discover-peloton"]).length,
      inspected:
        outputs["inspect-bikes"] === undefined ? 0 : readRiders(outputs["inspect-bikes"]).length,
      auditCars: typeof outputs["audit-cars"] === "number" ? outputs["audit-cars"] : undefined,
      valid: outputs["validate-tech"] === true,
      weather:
        typeof outputs["resolve-weather"] === "string" ? outputs["resolve-weather"] : undefined,
      publishedId:
        typeof outputs["publish-start-list"] === "string"
          ? outputs["publish-start-list"]
          : undefined,
    }),
  },
};
