import { createSteps, definePipeline } from "tubeless";

const { step: recordStep } = createSteps<{ email: string }>();

const lookupDomain = recordStep("lookup-domain", {
  run: (_inputs, context) => {
    const domain = context.options.email.split("@")[1];
    if (!domain) throw new Error(`No domain in ${JSON.stringify(context.options.email)}`);
    return domain;
  },
});

export const EnrichRecordPipeline = definePipeline({
  id: "enrich-record",
  steps: [lookupDomain],
});

const { step, forEachPipeline } = createSteps<{ emails: readonly string[] }>();

// "collect" completes the step with one settled entry per item, in item order,
// instead of failing it. Use "stop" to fail fast without starting more items.
const enrichRecords = forEachPipeline("enrich-records", {
  pipeline: EnrichRecordPipeline,
  items: (_inputs, context) => context.options.emails,
  key: (_email, index) => String(index),
  concurrency: 4,
  onItemFailure: "collect",
  mapOptions: (email) => ({ email }),
});

// The next step decides what a partial result means for the application.
const summarize = step("summarize", {
  dependsOn: [enrichRecords],
  run: ({ "enrich-records": settled }) => ({
    domains: settled.flatMap((entry) => (entry.ok && entry.value ? [entry.value] : [])),
    failed: settled.flatMap((entry) =>
      entry.ok ? [] : [{ index: entry.index, message: entry.error.message }]
    ),
  }),
});

export const PartialEnrichmentPipeline = definePipeline({
  id: "partial-enrichment",
  steps: [enrichRecords, summarize],
});
