import { createHash } from "node:crypto";
import { formatWithOxfmt } from "./format-with-oxfmt.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const check = process.argv.includes("--check");

const repositoryUrl = packageJson.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

function declarationItems(block) {
  return block
    .split(",")
    .map((item) => item.replace(/\/\*[\s\S]*?\*\//g, "").trim())
    .filter(Boolean)
    .map((item) => {
      const [local, exported = local] = item.replace(/^type\s+/, "").split(/\s+as\s+/);
      return { exported: exported.trim(), local: local.trim() };
    });
}

function exportedSymbols(declaration) {
  const symbols = new Set();
  const direct =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|const|enum|function|interface|type|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of declaration.matchAll(direct)) symbols.add(match[1]);

  const blocks = /export\s+(?:type\s+)?\{([\s\S]*?)\}(?:\s*from\s*["'][^"']+["'])?\s*;/g;
  for (const match of declaration.matchAll(blocks)) {
    for (const item of declarationItems(match[1])) symbols.add(item.exported);
  }
  if (/export\s+default\s/.test(declaration)) symbols.add("default");
  return [...symbols].sort((left, right) => left.localeCompare(right));
}

function summaryBefore(source, position) {
  const prefix = source.slice(0, position);
  const match = prefix.match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*$/);
  if (!match) return undefined;
  const lines = match[1].split("\n").map((line) => line.replace(/^\s*\* ?/, "").trim());
  const summaryLines = [];
  for (const line of lines) {
    if (line.startsWith("@")) break;
    if (line === "") {
      if (summaryLines.length > 0) break;
      continue;
    }
    summaryLines.push(line);
  }
  const summary = summaryLines
    .join(" ")
    .replace(/\{@link\s+([^\s}|]+)(?:\s*\|\s*([^}]+))?\}/g, (_match, target, label) =>
      label ? label.trim() : `\`${target}\``
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!summary) return undefined;
  const sentence = summary.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? summary;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function declarationModule(path) {
  const source = readFileSync(path, "utf8");
  const declarations = new Map();
  const declarationPattern =
    /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(class|const|enum|function|interface|type|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declarationPattern)) {
    const declaration = {
      description: summaryBefore(source, match.index),
      declarationPath: path,
      kind: match[1],
      name: match[2],
    };
    const existing = declarations.get(match[2]);
    if (!existing || (!existing.description && declaration.description)) {
      declarations.set(match[2], declaration);
    }
  }

  const imports = new Map();
  const importPattern = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']\s*;/g;
  for (const match of source.matchAll(importPattern)) {
    for (const item of declarationItems(match[1])) {
      imports.set(item.exported, { imported: item.local, specifier: match[2] });
    }
  }

  const exports = new Map();
  const exportPattern = /export\s+(?:type\s+)?\{([\s\S]*?)\}(?:\s*from\s*["']([^"']+)["'])?\s*;/g;
  for (const match of source.matchAll(exportPattern)) {
    for (const item of declarationItems(match[1])) {
      exports.set(item.exported, { local: item.local, specifier: match[2] });
    }
  }
  return { declarations, exports, imports };
}

function sourceLocation(declarationPath, symbolName) {
  const sourceBase = resolve(
    packageRoot,
    "src",
    relative(resolve(packageRoot, "dist"), declarationPath).replace(/\.d\.ts$/, "")
  );
  const sourcePath = [sourceBase + ".ts", sourceBase + ".tsx"].find((path) => existsSync(path));
  if (!sourcePath) return undefined;
  const source = readFileSync(sourcePath, "utf8");
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:class|const|enum|function|interface|type|let|var)\\s+${symbolName.replace(/[$]/g, "\\$")}\\b`,
    "m"
  );
  const match = pattern.exec(source);
  if (!match) return undefined;
  return {
    line: source.slice(0, match.index).split("\n").length,
    path: relative(packageRoot, sourcePath),
  };
}

export function resolveSymbolDocumentation(entryPath, symbolName) {
  const modules = new Map();
  const seen = new Set();
  function visit(path, exportedName) {
    const key = `${path}\0${exportedName}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    let module = modules.get(path);
    if (!module) {
      module = declarationModule(path);
      modules.set(path, module);
    }

    const declaration = module.declarations.get(exportedName);
    if (declaration) return declaration;
    const exported = module.exports.get(exportedName);
    if (!exported) return undefined;
    if (exported.specifier) {
      const next = resolveImportedDeclaration(path, exported.specifier);
      return next ? visit(next, exported.local) : undefined;
    }
    const local = module.declarations.get(exported.local);
    if (local) return local;
    const imported = module.imports.get(exported.local);
    if (!imported) return undefined;
    const next = resolveImportedDeclaration(path, imported.specifier);
    return next ? visit(next, imported.imported) : undefined;
  }

  const documentation = visit(resolve(entryPath), symbolName);
  if (!documentation) return undefined;
  const source = sourceLocation(documentation.declarationPath, documentation.name);
  return source ? { ...documentation, source } : undefined;
}

function sourceLink(source) {
  return `${repositoryUrl}/blob/main/${source.path}#L${source.line}`;
}

export function resolveImportedDeclaration(fromPath, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromPath), specifier);
  const candidates = base.endsWith(".d.ts")
    ? [base]
    : base.endsWith(".js")
      ? [`${base.slice(0, -3)}.d.ts`]
      : [`${base}.d.ts`, resolve(base, "index.d.ts")];
  return candidates.find((path) => existsSync(path));
}

export function collectDeclarationSources(entryPath) {
  const sources = new Map();
  const pending = [resolve(entryPath)];
  while (pending.length > 0) {
    const path = pending.pop();
    if (sources.has(path)) continue;
    const source = readFileSync(path, "utf8");
    sources.set(path, source);
    for (const match of source.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const next = resolveImportedDeclaration(path, match[1]);
      if (next) pending.push(next);
    }
  }
  return sources;
}

export function hashDeclarationSurface(entryPath, root = packageRoot) {
  const sources = collectDeclarationSources(entryPath);
  const hash = createHash("sha256");
  for (const path of [...sources.keys()].sort((left, right) => left.localeCompare(right))) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(sources.get(path));
    hash.update("\0");
  }
  return hash.digest("hex");
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
    const exports = exportedSymbols(source).map((name) => {
      const documentation = resolveSymbolDocumentation(declarationPath, name);
      if (!documentation) {
        throw new Error(`Could not resolve source documentation for ${name} from ${declaration}.`);
      }
      if (!documentation.description) {
        throw new Error(
          `Public symbol ${name} is missing a one-sentence doc comment in ${relative(packageRoot, documentation.declarationPath)}.`
        );
      }
      return {
        description: documentation.description,
        name,
        source: documentation.source,
      };
    });
    return {
      declaration,
      exports,
      sha256: hashDeclarationSurface(declarationPath),
      specifier: subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`,
    };
  });
  const report = {
    modules: modules.map((module) => ({
      ...module,
      exports: module.exports.map((symbol) => symbol.name),
    })),
    packageName: packageJson.name,
    schemaVersion: 1,
  };
  const markdown = [
    "# `tubeless` API reference",
    "",
    "Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.",
    "",
    "Each symbol links to its source declaration and uses the first sentence of its public doc comment.",
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
        : [
            "| Symbol | Description |",
            "| --- | --- |",
            ...module.exports.map(
              (symbol) =>
                `| [\`${symbol.name}\`](${sourceLink(symbol.source)}) | ${symbol.description.replace(/\|/g, "\\|")} |`
            ),
          ].join("\n"),
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

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
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
}
