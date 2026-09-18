import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function filesUnder(directory, extension) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && extname(entry.name) === extension)
    .map((entry) => join(entry.parentPath, entry.name));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateMarkdownLinks(filePath, skillRoot) {
  const source = readFileSync(filePath, "utf8");
  const links = source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = resolve(dirname(filePath), decodeURIComponent(target));
    if (skillRoot) {
      assert(
        !relative(skillRoot, resolved).startsWith(".."),
        `${filePath} links outside its installable skill folder: ${target}`
      );
    }
    assert(existsSync(resolved), `${filePath} links to missing ${target}`);
  }
}

const readmePath = join(packageRoot, "README.md");
const readmeLines = readFileSync(readmePath, "utf8").trimEnd().split("\n").length;
assert(
  readmeLines <= 120,
  `README.md is ${readmeLines} lines; keep the entrypoint at 120 or fewer`
);

for (const filePath of [readmePath, ...filesUnder(join(packageRoot, "docs"), ".md")]) {
  validateMarkdownLinks(filePath);
}

// Skills are installed independently; sibling repository files are not copied.
const skillsRoot = join(packageRoot, "skills");
for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const skillRoot = join(skillsRoot, entry.name);
  const skillPath = join(skillRoot, "SKILL.md");
  assert(existsSync(skillPath), `${skillRoot} is missing SKILL.md`);
  const source = readFileSync(skillPath, "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter, `${skillPath} needs YAML frontmatter`);
  const name = frontmatter[1].match(/^name: (.+)$/m)?.[1];
  assert(name === basename(skillRoot), `${skillPath} name must match its folder`);
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name), `${skillPath} needs a skill name`);
  assert(name.length <= 64, `${skillPath} name exceeds 64 characters`);
  assert(/^description: \S.+$/m.test(frontmatter[1]), `${skillPath} needs a description`);
  for (const filePath of filesUnder(skillRoot, ".md")) {
    validateMarkdownLinks(filePath, skillRoot);
  }
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

const agentGuide = readFileSync(join(packageRoot, "docs", "agent-guide.md"), "utf8");
assert(
  !agentGuide.includes("nearby production pipeline"),
  "Agent guide must not send authors to a production pipeline outside this package"
);
assert(
  agentGuide.includes("examples/catalog/tubeless.project.ts"),
  "Agent guide must point authors at the project manifest"
);
assert(
  recipes.includes("examples/catalog/tubeless.project.ts"),
  "Recipe index must point authors at the project manifest"
);
const concepts = readFileSync(join(packageRoot, "docs", "concepts.md"), "utf8");
const cliGuide = readFileSync(join(packageRoot, "docs", "cli.md"), "utf8");
const cliJob = readFileSync(join(packageRoot, "examples", "cli-job.ts"), "utf8");
assert(
  concepts.includes("`resume`, `stepIds`, and `targets`") &&
    !concepts.includes("`resume`, `step`, and `target`"),
  "Concepts must name command-only CLI values as stepIds/targets, not step/target"
);
assert(
  agentGuide.includes("`--step`") &&
    agentGuide.includes("`stepIds`") &&
    agentGuide.includes("`targets`"),
  "Agent guide must distinguish --step/--target flags from stepIds/targets values"
);
assert(
  recipes.includes("`--step`") && recipes.includes("`stepIds`") && recipes.includes("`targets`"),
  "Recipe index must distinguish --step/--target flags from stepIds/targets values"
);
assert(
  cliGuide.includes("`--step`") && cliGuide.includes("`stepIds`") && cliGuide.includes("`targets`"),
  "CLI guide must distinguish --step/--target flags from stepIds/targets values"
);
assert(
  cliJob.includes("`--step`") && cliJob.includes("`stepIds`") && cliJob.includes("`targets`"),
  "CLI recipe must distinguish --step/--target flags from stepIds/targets values"
);
const catalog = readFileSync(
  join(packageRoot, "examples", "catalog", "tubeless.project.ts"),
  "utf8"
);
assert(
  catalog.includes("--step/--target") &&
    catalog.includes("stepIds") &&
    catalog.includes("targets") &&
    catalog.includes('id: "import-rows"'),
  "Project manifest must declare stable IDs and distinguish --step/--target flags from stepIds/targets values"
);
const requiredDocuments = [
  "README.md",
  "docs/README.md",
  "docs/agent-guide.md",
  "docs/agent-skills.md",
  "docs/cli.md",
  "docs/concepts.md",
  "docs/getting-started.md",
  "docs/llms.txt",
  "docs/recipes.md",
  "docs/studio.md",
  "skills/tubeless/SKILL.md",
  "skills/tubeless-make-pipeline/SKILL.md",
  "examples/catalog/tubeless.project.ts",
  "examples/catalog/pipelines/import.ts",
  "examples/catalog/pipelines/normalize.ts",
  "examples/catalog/pipelines/publish.ts",
  "examples/catalog/scripts/import.ts",
  "examples/catalog/scripts/publish.ts",
];
for (const document of requiredDocuments) {
  const path = join(packageRoot, document);
  assert(existsSync(path) && statSync(path).isFile(), `Learning surface is missing ${document}`);
}

process.stdout.write("tubeless learning surface verified.\n");
