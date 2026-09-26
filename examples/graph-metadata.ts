import { createSteps, definePipeline, querySteps } from "tubeless";

const { step } = createSteps();

const read = step("read", {
  description: "Read customer records from the application source.",
  metadata: { owner: "data-platform", domain: "customers", tags: ["sensitive"] },
  run: () => [{ id: "customer-1" }],
});
const summarize = step("summarize", {
  dependsOn: [read],
  metadata: {
    owner: "analytics",
    domain: "customers",
    tags: ["aggregate"],
    annotations: { retentionDays: 30, governance: { reviewed: true } },
  },
  run: ({ read: customers }) => ({ count: customers.length }),
});

export const MetadataPipeline = definePipeline({
  id: "customer-summary",
  metadata: { owner: "analytics", annotations: { catalog: "customer-metrics" } },
  steps: [read, summarize],
});

// Discovery never selects operational work. Unfiltered runs still run both steps.
export const sensitiveSteps = querySteps(MetadataPipeline.plan(), { tags: ["sensitive"] });
export const analyticsDiagram = MetadataPipeline.toMermaid({
  query: { owner: "analytics" },
  includeMetadata: true,
});
