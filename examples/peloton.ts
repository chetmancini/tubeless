import { createSteps, definePipeline } from "tubeless";
import { runConcurrent } from "tubeless/batch";
import { definePipelineCommand } from "tubeless/cli";
import { RateLimiter } from "tubeless/rate-limit";
import { withRetry } from "tubeless/retry";

export interface PelotonRider {
  id: string;
  kit: readonly string[];
}

export interface PelotonOptions {
  cachedWeather?: string;
  concurrency: number;
  delay: number;
  failAudit?: boolean;
  refresh: boolean;
  riders: readonly PelotonRider[];
}

export interface PelotonResult {
  auditCars: number | undefined;
  inspected: number;
  publishedId: string | undefined;
  riders: number;
  valid: boolean;
  weather: string | undefined;
}

export const PELOTON_DEFAULT_DELAY_MS = 380;
export const PELOTON_RIDERS: readonly PelotonRider[] = [
  { id: "cobble", kit: [" Wheels ", "CAGE"] },
  { id: "alpine", kit: ["cassette"] },
  { id: "sprint", kit: ["Tires", "CHAIN"] },
];

const TEAM_CARS = ["lead-car", "spare-car"] as const;
const START_LIST_FILES = ["start-list.json", "timing.log", "weather.txt"] as const;

type DetailStatus = "completed" | "pending" | "running";

const normalizeStep = createSteps<{ delay: number; riders: readonly PelotonRider[] }>();
const inspectStep = createSteps<{
  delay: number;
  kit: readonly string[];
  riderId: string;
}>();
const step = createSteps<PelotonOptions>();

function sequentialStatus(index: number, current: number): DetailStatus {
  if (index < current) return "completed";
  if (index === current) return "running";
  return "pending";
}

function overlappingStatus(index: number, head: number): DetailStatus {
  if (index < head) return "completed";
  if (index === head || index === head + 1) return "running";
  return "pending";
}

async function pause(context: {
  options: { delay: number };
  signal?: AbortSignal;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<void> {
  await context.sleep(context.options.delay, context.signal);
}

const normalizeBikes = normalizeStep("normalize-rows", {
  name: "Trim Kit",
  description: "Trim and lowercase every rider kit list.",
  run: async (_inputs, context) => {
    const riders: PelotonRider[] = [];
    for (const [current, rider] of context.options.riders.entries()) {
      context.log.log(`normalize ${rider.id}`);
      context.reportProgress({
        completed: current,
        total: context.options.riders.length,
        message: "kit",
        details: context.options.riders.map((item, index) => ({
          id: item.id,
          label: "normalize",
          status: sequentialStatus(index, current),
        })),
      });
      riders.push({
        id: rider.id,
        kit: rider.kit.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0),
      });
      await pause(context);
    }
    return riders;
  },
});

export const NormalizeBikesPipeline = definePipeline({
  id: "normalize-bikes",
  steps: [normalizeBikes],
  targets: [normalizeBikes],
  finalize: (outputs) => outputs["normalize-rows"] ?? [],
});

const scanBike = inspectStep("scan-bike", {
  name: "Scan Bike",
  description: "Rate-limit a flaky race radio, then scan each kit item.",
  run: async (_inputs, context) => {
    const limiter = new RateLimiter(context.options.delay);
    const items: string[] = [];
    context.log.log(`inspect ${context.options.riderId}`);

    for (const [index, part] of context.options.kit.entries()) {
      const scanned = await withRetry(
        async ({ attempt }) => {
          context.reportAttempt(attempt, { part, riderId: context.options.riderId });
          await limiter.wait(context.signal);
          if (attempt === 1 && index === 0) {
            context.log.warn(`race radio drop on ${context.options.riderId}`);
            throw new Error("race radio drop");
          }
          await pause(context);
          return part;
        },
        {
          baseDelayMs: context.options.delay,
          jitter: false,
          maxAttempts: 2,
          signal: context.signal,
          sleep: context.sleep,
        }
      );
      items.push(scanned);
      context.reportProgress({
        completed: index + 1,
        total: context.options.kit.length,
        message: part,
        details: context.options.kit.map((id, partIndex) => ({
          id,
          label: "scan",
          status: sequentialStatus(partIndex, index),
        })),
      });
    }

    return { items, riderId: context.options.riderId };
  },
});

export const InspectBikePipeline = definePipeline({
  id: "inspect-bike",
  steps: [scanBike],
  targets: [scanBike],
  finalize: (outputs) => outputs["scan-bike"],
});

const discoverPeloton = step("discover-peloton", {
  name: "Discover Peloton",
  description: "Walk the start village one rider at a time so nested details shimmer.",
  run: async (_inputs, context) => {
    context.log.log("race radio: scanning the peloton");
    for (const [current, rider] of context.options.riders.entries()) {
      context.log.log(`inbound ${rider.id} · ${rider.kit.length} kit item(s)`);
      context.reportProgress({
        completed: current + 1,
        total: context.options.riders.length,
        message: "riders",
        details: context.options.riders.map((item, index) => ({
          id: item.id,
          label: "sign-on",
          status: sequentialStatus(index, current),
        })),
      });
      await pause(context);
    }
    return context.options.riders;
  },
});

const resolveWeather = step.skippable("resolve-weather", {
  name: "Resolve Weather",
  description: "Reuse a posted forecast unless the race asks for a refresh.",
  skip: (_inputs, context) =>
    !context.options.refresh && context.options.cachedWeather !== undefined
      ? { reason: "weather already posted", value: context.options.cachedWeather }
      : false,
  run: async (_inputs, context) => {
    context.log.log("reading the weather station");
    context.reportProgress({ completed: 0, total: 1, message: "station" });
    await pause(context);
    context.reportProgress({ completed: 1, total: 1, message: "dry" });
    return "dry";
  },
});

const normalizedBikes = step.fromPipeline("normalize-bikes", {
  name: "Normalize Bikes",
  dependsOn: [discoverPeloton],
  description: "Normalize kit lists through the independently useful child pipeline.",
  pipeline: NormalizeBikesPipeline,
  mapOptions: ({ "discover-peloton": riders }, context) => ({
    delay: context.options.delay,
    riders,
  }),
});

const inspectBikes = step.forEachPipeline("inspect-bikes", {
  name: "Inspect Bikes",
  dependsOn: [normalizedBikes],
  description: "Fan out bike inspections with bounded concurrency and stable rider keys.",
  pipeline: InspectBikePipeline,
  items: ({ "normalize-bikes": riders }) => riders,
  key: (rider) => rider.id,
  concurrency: (_inputs, context) => context.options.concurrency,
  progress: { itemNoun: "bikes" },
  mapOptions: (rider, _index, _inputs, context) => ({
    delay: context.options.delay,
    kit: rider.kit,
    riderId: rider.id,
  }),
});

const auditCars = step("audit-cars", {
  name: "Audit Team Cars",
  dependsOn: [discoverPeloton],
  description: "Independent team-car checks that can continue after a failure.",
  run: async (_inputs, context) => {
    if (context.options.failAudit) {
      context.log.error("team-car audit failed");
      throw new Error("team-car audit failed");
    }
    context.log.log("walking the team cars");
    const cars = await runConcurrent(
      TEAM_CARS,
      { concurrency: context.options.concurrency, signal: context.signal },
      async (car, index) => {
        context.reportProgress({
          completed: index,
          total: TEAM_CARS.length,
          message: "cars",
          details: TEAM_CARS.map((id, carIndex) => ({
            id,
            label: "audit",
            status: overlappingStatus(carIndex, index),
          })),
        });
        await pause(context);
        return car;
      }
    );
    context.reportProgress({ completed: cars.length, total: TEAM_CARS.length, message: "cars" });
    return { cars: cars.length };
  },
});

const validateTech = step("validate-tech", {
  name: "Validate Tech",
  dependsOn: [inspectBikes, resolveWeather],
  description: "Fail before the start list if a bike is empty.",
  run: async ({ "inspect-bikes": bikes, "resolve-weather": weather }, context) => {
    for (const [index, bike] of bikes.entries()) {
      if (bike === undefined || bike.items.length === 0) {
        throw new Error(`empty bike on ${bike?.riderId ?? `#${index}`}`);
      }
    }
    context.log.log(`commissaire valid on ${weather ?? "unknown"} weather`);
    await pause(context);
    return { valid: true, weather: weather ?? "unknown" };
  },
});

const publishStartList = step("publish-start-list", {
  name: "Publish Start List",
  dependsOn: [inspectBikes],
  optionalDependsOn: [validateTech],
  skipAfterFailureOf: [validateTech],
  description: "Write the start list only on real runs after tech has not failed.",
  dryRun: "skip",
  run: async ({ "inspect-bikes": bikes }, context) => {
    context.log.log("posting the start list");
    for (const [current] of START_LIST_FILES.entries()) {
      context.reportProgress({
        completed: current,
        total: START_LIST_FILES.length,
        message: "files",
        details: START_LIST_FILES.map((id, index) => ({
          id,
          label: "write",
          status: sequentialStatus(index, current),
        })),
      });
      await pause(context);
    }
    return { publishedId: `start-list-${bikes.length}` };
  },
});

export const PelotonPipeline = definePipeline({
  id: "peloton",
  steps: [
    discoverPeloton,
    resolveWeather,
    normalizedBikes,
    inspectBikes,
    auditCars,
    validateTech,
    publishStartList,
  ],
  targets: [publishStartList],
  finalize: (outputs) => ({
    auditCars: outputs["audit-cars"]?.cars,
    inspected: outputs["inspect-bikes"]?.length ?? 0,
    publishedId: outputs["publish-start-list"]?.publishedId,
    riders: outputs["discover-peloton"]?.length ?? 0,
    valid: outputs["validate-tech"]?.valid === true,
    weather: outputs["resolve-weather"] ?? outputs["validate-tech"]?.weather,
  }),
});

/**
 * Slow on purpose so the live TUI can show fan-out, retries, skips, and gates.
 *
 *   bun examples/peloton.ts
 *   bun examples/peloton.ts --delay 220
 *   bun examples/peloton.ts --dry-run
 */
export const PelotonCommand = definePipelineCommand(PelotonPipeline, {
  description: "Road-race weekend: discover, skip, compose, fan out, retry, gate, and publish.",
  params: {
    delay: {
      type: "number",
      optional: true,
      integer: true,
      min: 0,
      description: "Milliseconds to hold each progress tick (default 380).",
    },
    refresh: {
      type: "boolean",
      description: "Refetch weather even when a cached forecast is supplied.",
    },
  },
  mapOptions: (args) => ({
    concurrency: 2,
    delay: args.delay ?? PELOTON_DEFAULT_DELAY_MS,
    refresh: args.refresh,
    riders: PELOTON_RIDERS,
  }),
  summarize: (result) => [
    result.publishedId
      ? `Posted ${result.inspected} rider(s) on ${result.weather ?? "unknown"} weather as ${result.publishedId}.`
      : `Inspected ${result.inspected} rider(s); the start list was not published.`,
  ],
});

export async function runPelotonExample() {
  return PelotonPipeline.runOrThrow({
    concurrency: 2,
    delay: 0,
    refresh: false,
    riders: PELOTON_RIDERS,
  });
}

if (import.meta.main) {
  void PelotonCommand.main();
}
