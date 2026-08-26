import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function filesUnder(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path, extension);
    return extname(path) === extension ? [path] : [];
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateMarkdownLinks(filePath) {
  const source = readFileSync(filePath, "utf8");
  const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = resolve(dirname(filePath), decodeURIComponent(target));
    assert(existsSync(resolved), `${filePath} links to missing ${target}`);
  }
}

const readmePath = join(packageRoot, "README.md");
const readmeLines = readFileSync(readmePath, "utf8").trimEnd().split("\n").length;
assert(
  readmeLines <= 160,
  `README.md is ${readmeLines} lines; keep the entrypoint at 160 or fewer`
);

for (const filePath of [readmePath, ...filesUnder(join(packageRoot, "docs"), ".md")]) {
  validateMarkdownLinks(filePath);
}

const recipes = readFileSync(join(packageRoot, "docs", "recipes.md"), "utf8");
const linkedExamples = [...recipes.matchAll(/\.\.\/examples\/([a-z0-9-]+\.ts)/g)].map(
  (match) => match[1]
);
assert(
  new Set(linkedExamples).size >= 8,
  "Recipe index must link at least eight compiled examples"
);
for (const example of linkedExamples) {
  assert(
    existsSync(join(packageRoot, "examples", example)),
    `Recipe example is missing: ${example}`
  );
}

const evaluationPath = join(packageRoot, "evals", "agent-cases.json");
const evaluations = JSON.parse(readFileSync(evaluationPath, "utf8"));
assert(evaluations.schemaVersion === 1, "Agent evaluation schemaVersion must be 1");
assert(
  Array.isArray(evaluations.cases) && evaluations.cases.length >= 6,
  "Need at least six agent cases"
);
const evaluationIds = new Set();
for (const evaluation of evaluations.cases) {
  assert(typeof evaluation.id === "string" && evaluation.id.length > 0, "Agent case needs an id");
  assert(!evaluationIds.has(evaluation.id), `Duplicate agent case id: ${evaluation.id}`);
  evaluationIds.add(evaluation.id);
  assert(
    typeof evaluation.prompt === "string" && evaluation.prompt.length > 20,
    `${evaluation.id} needs a prompt`
  );
  assert(evaluation.mustDemonstrate?.length > 0, `${evaluation.id} needs mustDemonstrate checks`);
  assert(evaluation.mustAvoid?.length > 0, `${evaluation.id} needs mustAvoid checks`);
}

const evaluationGuide = readFileSync(join(packageRoot, "docs", "agent-evaluations.md"), "utf8");
assert(
  evaluationGuide.includes("bun run eval:agent"),
  "Agent evaluation guide must document the executable verifier"
);
for (const script of [
  "scripts/evaluate-agent-submission.mjs",
  "scripts/verify-agent-evaluation-runner.mjs",
]) {
  assert(existsSync(join(packageRoot, script)), `Agent evaluation tooling is missing ${script}`);
}

const requiredDocuments = [
  "README.md",
  "docs/README.md",
  "docs/agent-guide.md",
  "docs/concepts.md",
  "docs/getting-started.md",
  "docs/llms.txt",
  "docs/recipes.md",
  "evals/agent-cases.json",
];
for (const document of requiredDocuments) {
  const path = join(packageRoot, document);
  assert(existsSync(path) && statSync(path).isFile(), `Learning surface is missing ${document}`);
}

process.stdout.write("tubeless learning surface verified.\n");
