// Context for the published recording, from the fixtures in scripts/eval-agent.mjs.
// Update alongside agent-evaluation.json when replacing that recording.
export const RECORDING_CONTEXT: Record<string, {
  title: string;
  setup: string;
  expected: string;
  files: Record<string, string>;
}> = {
  "investigate-edit-verify": {
    title: "Fix cents rounding",
    setup: "The agent starts in the project root. price.mjs rounds prices down, so the existing checks fail for values such as 1.005.",
    expected: "cents(1.005) returns 101, cents(12.345) returns 1235, and cents(0) returns 0. The agent runs the checks and preserves the tests and unrelated files.",
    files: {
      "price.mjs": "export function cents(value) { return Math.floor(value * 100); }",
      "check.mjs": 'import assert from "node:assert/strict";\nimport { cents } from "./price.mjs";\nassert.equal(cents(1.005), 101);\nassert.equal(cents(12.345), 1235);\nassert.equal(cents(0), 0);\nconsole.log("price checks passed");',
    },
  },
  "project-context": {
    title: "Implement a greeting from project instructions",
    setup: "The agent starts in src/. greet() always returns “hello”. Root and local AGENTS.md instructions must be present in its first model request. The local instructions specify the greeting format.",
    expected: 'Using the supplied instructions, the agent reads and edits only greet.mjs, then runs node ../check.mjs successfully on the first attempt. It must not reread guidance or inspect tests. greet("  Ada  ") returns "Ahoy, Ada!" and a blank name returns "Ahoy, friend!".',
    files: {
      "src/AGENTS.md": 'Greeting format is exactly "Ahoy, <trimmed name>!". Empty names use "friend". Run node ../check.mjs to verify.',
      "src/greet.mjs": 'export function greet(name) { return "hello"; }',
      "check.mjs": 'import assert from "node:assert/strict";\nimport { greet } from "./src/greet.mjs";\nassert.equal(greet("  Ada  "), "Ahoy, Ada!");\nassert.equal(greet("  "), "Ahoy, friend!");\nconsole.log("greeting checks passed");',
    },
  },
  "nested-guidance": {
    title: "Read a code using nested instructions",
    setup: "The agent starts in the project root. The requested file is inside src/, which has its own AGENTS.md. The agent must discover those instructions before reading the code.",
    expected: 'The agent reads src/AGENTS.md in an earlier turn than src/code.txt and answers "Scoped code: cobalt". It uses only read, list, and search, leaving every file unchanged.',
    files: {
      "src/AGENTS.md": 'Report codes from this directory with the prefix "Scoped code: ".',
      "src/code.txt": "cobalt",
      "check.mjs": 'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nassert.equal(readFileSync("src/code.txt", "utf8"), "cobalt\\n");\nconsole.log("guidance checks passed");',
    },
  },
  "recover-and-compact": {
    title: "Recover from a missing configuration file",
    setup: "The agent starts in the project root. legacy-config.json does not exist. The actual configuration is config/current.json, with retries set to 0.",
    expected: "After the missing-file error, the agent locates the current configuration, changes only retries to 3, and runs the checks. The conversation also compacts during this run.",
    files: {
      "config/current.json": '{"retries":0,"region":"us-east-1","notes":"Keep this exact note."}',
      "check.mjs": 'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nconst config = JSON.parse(readFileSync("config/current.json", "utf8"));\nassert.deepEqual(config, { retries: 3, region: "us-east-1", notes: "Keep this exact note." });\nconsole.log("config checks passed");',
    },
  },
};

export const ROOT_INSTRUCTIONS = "Read relevant source before editing. Run node check.mjs from the project root after changes. Do not modify check.mjs or unrelated.txt.";
