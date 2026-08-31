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

export const inspectTape: Tape = {
  id: "inspect",
  title: "inspect",
  command: "bunx tubeless inspect ./examples/typed-import.ts",
  lines: [
    { text: "Pipeline import" },
    { text: "Targets: normalize-rows" },
    { text: "Exact steps: load-rows, normalize-rows" },
    { text: "Pipeline import: plan (ok=true, dryRun=false, steps=2)", kind: "dim" },
    { text: "  - load-rows: run - Read raw input records from the caller.", kind: "run" },
    {
      text: "  - Normalize Rows [normalize-rows]: run - Normalize records after the raw rows are available.",
      kind: "run",
    },
  ],
};

export const planTape: Tape = {
  id: "plan",
  title: "plan",
  command: "bunx tubeless plan ./examples/typed-import.ts --target normalize-rows --explain",
  lines: [
    { text: "Pipeline import: plan (ok=true, dryRun=false, steps=2)", kind: "dim" },
    {
      text: "  - load-rows: run (required by normalize-rows for target normalize-rows)",
      kind: "run",
    },
    { text: "  - Normalize Rows [normalize-rows]: run (target normalize-rows)", kind: "ok" },
  ],
};

export const graphTape: Tape = {
  id: "graph",
  title: "graph",
  command: "bunx tubeless graph ./examples/typed-import.ts --markdown --direction LR",
  lines: [
    { text: "```mermaid" },
    { text: "flowchart LR" },
    { text: '  step0["load-rows"]' },
    { text: '  step1["Normalize Rows"]' },
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

export const dryRunTape: Tape = {
  id: "dry-run",
  title: "dry-run",
  command: "bunx tubeless plan ./examples/publish-with-gates.ts --dry-run --explain",
  lines: [
    { text: "Pipeline publish: plan (ok=true, dryRun=true, steps=3)", kind: "dim" },
    { text: "  - build-artifact: run - Build an artifact that can be validated and published.", kind: "run" },
    { text: "  - validate-artifact: run - Fail before publishing if the artifact is empty.", kind: "run" },
    {
      text: "  - publish-artifact: skip: dry-run - Publish only on real runs, after validation.",
      kind: "skip",
    },
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
