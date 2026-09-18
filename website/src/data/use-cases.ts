export const USE_CASES_INTRO = "Bring structure to the scripts that build, train, generate, and move your data. Tubeless connects typed steps so you can preview the work and see what happened at each stage.";

export const USE_CASES = [
  {
    id: "ci-cd",
    label: "CI/CD",
    headline: "Make every release step explicit.",
    summary: "Run the same release logic locally and in your CI runner.",
    description: "Turn build, validation, and publication scripts into one pipeline. Pass artifacts between typed steps and make successful checks a prerequisite for publishing.",
    stages: ["Build artifact", "Validate", "Publish"],
    benefits: [
      { title: "Check the plan before a release", detail: "Preview a target and its prerequisites without executing steps. Mark publication steps to skip during dry runs." },
      { title: "Find the failed step", detail: "Record step results, timings, and logs. Export an NDJSON trace as a CI artifact to inspect after the job ends." },
    ],
    boundary: "Your CI platform supplies runners, secrets, triggers, and approvals. Tubeless coordinates the steps inside the job.",
    recipes: [
      { label: "Publication with failure gates", file: "publish-with-gates.ts" },
      { label: "Pipeline-backed CLI", file: "cli-job.ts" },
    ],
    guide: { label: "Explore CLI execution", path: "cli" },
  },
  {
    id: "ml-flows",
    label: "ML flows",
    headline: "Connect the work around your model.",
    summary: "Coordinate dataset preparation, training jobs, and evaluation.",
    description: "Keep the path from a dataset to a model artifact in one typed workflow. Use your own functions for preparation and evaluation, and call a training service when the heavy compute belongs elsewhere.",
    stages: ["Prepare dataset", "Train remotely", "Evaluate", "Register model"],
    benefits: [
      { title: "Reuse an evaluation workflow", detail: "Compose evaluation as a child pipeline, then fan out across datasets or model candidates with bounded concurrency and per-item progress." },
      { title: "Check results at the boundary", detail: "Validate remote outputs with a schema and make model registration depend on an evaluation step that rejects unacceptable results." },
    ],
    boundary: "Your training stack owns GPU execution and model tracking. Tubeless coordinates calls to it; a durable host can own job delivery and retries.",
    recipes: [
      { label: "Validated remote calls", file: "remote-steps.ts" },
      { label: "Fan-out with progress", file: "fan-out-progress.ts" },
    ],
    guide: { label: "Explore remote steps", path: "remote-step-composition" },
  },
  {
    id: "llm-workflows",
    label: "LLM workflows",
    headline: "Give each model call a place in the flow.",
    summary: "Connect retrieval, generation, and validation with typed outputs.",
    description: "Build a document enrichment job, a retrieval-augmented answer flow, or a batch evaluation. Keep prompts and provider calls in your own code while Tubeless tracks the steps around them.",
    stages: ["Retrieve context", "Generate", "Validate output", "Save result"],
    benefits: [
      { title: "Control API traffic", detail: "Use retry and rate-limit helpers around provider calls. Fan out over documents with bounded concurrency and forward cancellation to requests." },
      { title: "Validate before saving", detail: "Check structured model output with a schema before downstream steps consume it. Use a custom dry-run handler for a preview that avoids a paid model call." },
    ],
    boundary: "You choose the model SDK, retrieval system, and validation rules. Tubeless adds workflow structure without a built-in model provider or agent loop.",
    recipes: [
      { label: "Retry and rate-limit calls", file: "resumable-enrichment.ts" },
      { label: "Validate output boundaries", file: "validated-boundaries.ts" },
    ],
    guide: { label: "Explore child pipelines", path: "child-pipeline-composition" },
  },
  {
    id: "data-pipelines",
    label: "Data pipelines",
    headline: "Follow your data from source to destination.",
    summary: "Build typed imports, enrichment jobs, and exports.",
    description: "Read from your source, normalize records, enrich them through an API, and write the result. Each step declares the data it needs, with TypeScript checking the values passed between steps.",
    stages: ["Extract", "Normalize", "Enrich", "Write"],
    benefits: [
      { title: "See progress through a batch", detail: "Report completed items and inspect keyed failures in child pipelines. Use checkpointed batch helpers when your application needs to track completed work for a later run." },
      { title: "Preview writes deliberately", detail: "Mark database and filesystem writes to skip during dry runs, or supply a side-effect-free preview handler. Inspect recorded logs and timings in the local Studio." },
    ],
    boundary: "Your code owns source connectors, destination writes, and checkpoint policy. Tubeless runs in your process; use an external host when you need distributed scheduling or crash recovery.",
    recipes: [
      { label: "Typed import pipeline", file: "typed-import.ts" },
      { label: "Checkpointed enrichment", file: "resumable-enrichment.ts" },
    ],
    guide: { label: "Browse the recipe index", path: "recipes" },
  },
  {
    id: "operational-workflows",
    label: "Operational workflows",
    headline: "Turn repeat tasks into inspectable runbooks.",
    summary: "Give maintenance scripts and support tools a shared way to run.",
    description: "Wrap a tenant setup task, a migration, or a maintenance script in a named command. Declare its inputs and prerequisites so teammates can preview the work and follow its progress.",
    stages: ["Check inputs", "Plan changes", "Apply changes", "Verify"],
    benefits: [
      { title: "Offer one command catalog", detail: "Register commands explicitly in a project manifest. Use the same definitions from the terminal or launch them through the local Studio." },
      { title: "Make side effects visible", detail: "Provide dry-run previews for mutations and record real runs for troubleshooting. Pass cancellation into long-running work and inspect the steps that completed." },
    ],
    boundary: "Your application owns permissions, credentials, and compensation for partial changes. Dry runs and cancellation do not roll back external side effects.",
    recipes: [
      { label: "Shared project catalog", file: "catalog/tubeless.project.ts" },
      { label: "Cancellation and testing", file: "cancellation-and-testing.ts" },
    ],
    guide: { label: "Explore the local Studio", path: "studio" },
  },
];
