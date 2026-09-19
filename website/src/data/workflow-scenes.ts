export type WorkflowObjectKind = "workshop" | "database" | "server" | "brain" | "chip" | "gate" | "parcel" | "document" | "funnel" | "chart" | "console";

type SceneNode = {
  id: string;
  label: string;
  kind: WorkflowObjectKind;
  x: number;
  y: number;
  at: number;
  color?: string;
};

type Scene = {
  title: string;
  description: string;
  pattern: string;
  nodes: SceneNode[];
  edges: { from: string; to: string; at: number }[];
};

// Illustrative workflows, not execution plans for the linked recipes.
export const WORKFLOW_SCENES: Record<string, Scene> = {
  "ci-cd": {
    title: "Build, test, and deploy",
    description: "A build fans out into tests and packaging. Both branches join at a release gate before deployment.",
    pattern: "FAN OUT → CHECK + PACKAGE → JOIN → DEPLOY",
    nodes: [
      { id: "build", label: "Build", kind: "workshop", x: 115, y: 230, at: 0 },
      { id: "tests", label: "Tests", kind: "gate", x: 350, y: 115, at: 2 },
      { id: "package", label: "Package", kind: "parcel", x: 350, y: 340, at: 2, color: "blue" },
      { id: "release", label: "Release gate", kind: "gate", x: 625, y: 230, at: 4.2 },
      { id: "deploy", label: "Deploy", kind: "server", x: 875, y: 230, at: 6.4 },
    ],
    edges: [
      { from: "build", to: "tests", at: 0.9 }, { from: "build", to: "package", at: 0.9 },
      { from: "tests", to: "release", at: 3.1 }, { from: "package", to: "release", at: 3.1 },
      { from: "release", to: "deploy", at: 5.3 },
    ],
  },
  "ml-flows": {
    title: "Compare three model experiments",
    description: "A dataset fans out to three model experiments. Their results converge for evaluation, and the chosen model is registered.",
    pattern: "DATASET → PARALLEL EXPERIMENTS → EVALUATE → REGISTER",
    nodes: [
      { id: "data", label: "Training data", kind: "database", x: 100, y: 230, at: 0 },
      { id: "a", label: "Experiment A", kind: "chip", x: 345, y: 95, at: 2, color: "blue" },
      { id: "b", label: "Experiment B", kind: "chip", x: 345, y: 240, at: 2, color: "rose" },
      { id: "c", label: "Experiment C", kind: "chip", x: 345, y: 375, at: 2, color: "green" },
      { id: "evaluate", label: "Compare scores", kind: "chart", x: 630, y: 230, at: 4.2 },
      { id: "register", label: "Selected model", kind: "parcel", x: 880, y: 230, at: 6.4 },
    ],
    edges: [
      { from: "data", to: "a", at: 0.9 }, { from: "data", to: "b", at: 0.9 }, { from: "data", to: "c", at: 0.9 },
      { from: "a", to: "evaluate", at: 3.1 }, { from: "b", to: "evaluate", at: 3.1 }, { from: "c", to: "evaluate", at: 3.1 },
      { from: "evaluate", to: "register", at: 5.3 },
    ],
  },
  "llm-workflows": {
    title: "Answer a question with retrieved context",
    description: "A question starts retrieval and a tool call. Retrieved context, tool results, and the original question all feed a model, which produces an answer.",
    pattern: "QUESTION + RETRIEVED CONTEXT + TOOL RESULTS → GENERATE",
    nodes: [
      { id: "question", label: "Question", kind: "document", x: 100, y: 230, at: 0 },
      { id: "retrieve", label: "Knowledge base", kind: "database", x: 340, y: 110, at: 2 },
      { id: "tools", label: "Tool call", kind: "console", x: 340, y: 350, at: 2, color: "blue" },
      { id: "model", label: "Context + model", kind: "brain", x: 650, y: 230, at: 4.2 },
      { id: "answer", label: "Answer", kind: "document", x: 890, y: 230, at: 6.4, color: "rose" },
    ],
    edges: [
      { from: "question", to: "retrieve", at: 0.9 }, { from: "question", to: "tools", at: 0.9 },
      { from: "question", to: "model", at: 2.4 },
      { from: "retrieve", to: "model", at: 3.1 }, { from: "tools", to: "model", at: 3.1 },
      { from: "model", to: "answer", at: 5.3 },
    ],
  },
  "data-pipelines": {
    title: "Combine data from several sources",
    description: "Database rows, API responses, and files merge into a normalization step. The cleaned data branches out to a warehouse and a report.",
    pattern: "MERGE SOURCES → NORMALIZE → FAN OUT TO DESTINATIONS",
    nodes: [
      { id: "rows", label: "Database", kind: "database", x: 130, y: 95, at: 0 },
      { id: "api", label: "API", kind: "console", x: 130, y: 240, at: 0, color: "blue" },
      { id: "files", label: "Files", kind: "document", x: 130, y: 375, at: 0 },
      { id: "normalize", label: "Normalize", kind: "funnel", x: 460, y: 230, at: 2 },
      { id: "warehouse", label: "Warehouse", kind: "database", x: 810, y: 125, at: 4.2, color: "blue" },
      { id: "report", label: "Report", kind: "chart", x: 810, y: 340, at: 4.2 },
    ],
    edges: [
      { from: "rows", to: "normalize", at: 0.9 }, { from: "api", to: "normalize", at: 0.9 }, { from: "files", to: "normalize", at: 0.9 },
      { from: "normalize", to: "warehouse", at: 3.1 }, { from: "normalize", to: "report", at: 3.1 },
    ],
  },
  "operational-workflows": {
    title: "Back up, repair, and verify",
    description: "A maintenance request branches into a backup and preflight checks. Both must finish before a repair, which branches into verification and an audit record.",
    pattern: "BACK UP + CHECK → REPAIR → VERIFY + RECORD",
    nodes: [
      { id: "request", label: "Run request", kind: "console", x: 100, y: 230, at: 0 },
      { id: "backup", label: "Backup", kind: "database", x: 340, y: 115, at: 2, color: "blue" },
      { id: "preflight", label: "Preflight", kind: "gate", x: 340, y: 340, at: 2 },
      { id: "repair", label: "Repair", kind: "workshop", x: 620, y: 230, at: 4.2 },
      { id: "verify", label: "Verify", kind: "gate", x: 875, y: 115, at: 6.4 },
      { id: "audit", label: "Audit record", kind: "document", x: 875, y: 340, at: 6.4 },
    ],
    edges: [
      { from: "request", to: "backup", at: 0.9 }, { from: "request", to: "preflight", at: 0.9 },
      { from: "backup", to: "repair", at: 3.1 }, { from: "preflight", to: "repair", at: 3.1 },
      { from: "repair", to: "verify", at: 5.3 }, { from: "repair", to: "audit", at: 5.3 },
    ],
  },
};
