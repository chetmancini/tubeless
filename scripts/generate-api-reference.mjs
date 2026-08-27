import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const check = process.argv.includes("--check");

function formatWithOxfmt(contents, filepath) {
  const result = spawnSync("oxfmt", ["--stdin-filepath", filepath], {
    cwd: packageRoot,
    encoding: "utf8",
    input: contents,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`oxfmt failed for ${filepath}: ${result.stderr}`);
  }
  return result.stdout;
}

function exportedSymbols(declaration) {
  const symbols = new Set();
  const direct =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|const|enum|function|interface|type|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of declaration.matchAll(direct)) symbols.add(match[1]);

  const blocks = /export\s+(?:type\s+)?\{([\s\S]*?)\}(?:\s*from\s*["'][^"']+["'])?\s*;/g;
  for (const match of declaration.matchAll(blocks)) {
    for (const item of match[1].split(",")) {
      const normalized = item.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!normalized) continue;
      const exported = normalized
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (exported) symbols.add(exported);
    }
  }
  if (/export\s+default\s/.test(declaration)) symbols.add("default");
  return [...symbols].sort((left, right) => left.localeCompare(right));
}

async function generatedFiles() {
  const modules = Object.entries(packageJson.exports).map(([subpath, conditions]) => {
    const declaration = conditions.types;
    if (typeof declaration !== "string") {
      throw new Error(`Export ${subpath} is missing a types declaration.`);
    }
    const declarationPath = resolve(packageRoot, declaration);
    if (!existsSync(declarationPath)) {
      throw new Error(`Build tubeless before generating its API reference: missing ${declaration}`);
    }
    const source = readFileSync(declarationPath, "utf8");
    return {
      declaration,
      exports: exportedSymbols(source),
      sha256: createHash("sha256").update(source).digest("hex"),
      specifier: subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`,
    };
  });
  const report = { modules, packageName: packageJson.name, schemaVersion: 1 };
  const markdown = [
    "# `tubeless` API reference",
    "",
    "Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.",
    "",
    `Package: \`${packageJson.name}\``,
    "",
    "## Public entrypoints",
    "",
    "| Entrypoint | Declaration | Surface hash | Exported symbols |",
    "| --- | --- | --- | ---: |",
    ...modules.map(
      (module) =>
        `| \`${module.specifier}\` | \`${module.declaration}\` | \`${module.sha256}\` | ${module.exports.length} |`
    ),
    "",
    "## Symbols",
    "",
    ...modules.flatMap((module) => [
      `### \`${module.specifier}\``,
      "",
      module.exports.length === 0
        ? "No named exports."
        : module.exports.map((symbol) => `- \`${symbol}\``).join("\n"),
      "",
    ]),
  ].join("\n");
  return new Map([
    [
      resolve(packageRoot, "docs", "api-reference.md"),
      formatWithOxfmt(`${markdown}\n`, resolve(packageRoot, "docs", "api-reference.md")),
    ],
    [
      resolve(packageRoot, "docs", "api-report.json"),
      formatWithOxfmt(
        `${JSON.stringify(report, null, 2)}\n`,
        resolve(packageRoot, "docs", "api-report.json")
      ),
    ],
  ]);
}

const files = await generatedFiles();
const stale = [];
for (const [path, contents] of files) {
  const actual = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (actual === contents) continue;
  if (check) {
    stale.push(relative(packageRoot, path));
  } else {
    writeFileSync(path, contents);
    process.stdout.write(`Generated ${relative(packageRoot, path)}\n`);
  }
}

if (stale.length > 0) {
  throw new Error(
    `Generated tubeless API files are stale: ${stale.join(", ")}. Run: bun run api:generate`
  );
}
