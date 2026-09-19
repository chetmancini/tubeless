export type TapeLine = {
  text: string;
  kind?: "out" | "ok" | "run" | "skip" | "dim" | "log";
};

export type Tape = {
  id: string;
  title: string;
  command: string;
  lines: TapeLine[];
};

export const planTape: Tape = {
  id: "plan",
  title: "plan",
  command: "bunx tubeless plan ./examples/minimal-pipeline.ts --target normalize --explain",
  lines: [
    { text: "Pipeline minimal: plan (ok=true, dryRun=false, steps=2)", kind: "dim" },
    {
      text: "  - load: run (required by normalize for target normalize) - Read rows supplied by the caller.",
      kind: "run",
    },
    {
      text: "  - normalize: run (target normalize) - Trim rows and remove empty entries.",
      kind: "ok",
    },
  ],
};

export const graphTape: Tape = {
  id: "graph",
  title: "graph",
  command: "bunx tubeless graph ./examples/minimal-pipeline.ts --markdown --direction LR",
  lines: [
    { text: "```mermaid" },
    { text: "flowchart LR" },
    { text: '  step0["load"]' },
    { text: '  step1["normalize"]' },
    { text: "" },
    { text: "  step0 --> step1" },
    { text: "```" },
  ],
};

export const runTape: Tape = {
  id: "run",
  title: "run",
  command: "bunx tubeless run ./examples/cli-job.ts -- --source examples/rows.txt --limit 2",
  lines: [
    { text: "Pipeline import: starting (2 steps, dryRun=false)", kind: "dim" },
    { text: "  -> load-rows - Read raw input records from the caller.", kind: "run" },
    { text: "  ok load-rows (1ms)", kind: "ok" },
    { text: "  -> normalize-rows - Trim, lowercase, drop blanks, and apply --limit.", kind: "run" },
    { text: "  ok normalize-rows (0ms)", kind: "ok" },
    { text: "  -> finalize", kind: "run" },
    { text: "  ok finalize (0ms)", kind: "ok" },
    { text: "Pipeline import: done in 1ms (status=completed, steps=2, errors=0)", kind: "ok" },
    { text: "Normalized 2 row(s)." },
  ],
};

export type LiveStep = {
  id: string;
  name: string;
  detail?: string;
};

export const liveSteps: LiveStep[] = [
  { id: "discover", name: "Discover Sources", detail: "catalogs 4/4" },
  { id: "fetch", name: "Fetch Records", detail: "sources 4/4" },
  { id: "transform", name: "Transform Rows", detail: "rows ready" },
  { id: "publish", name: "Publish Artifacts", detail: "files 3/3" },
];
