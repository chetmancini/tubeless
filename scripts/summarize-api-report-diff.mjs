import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reportPath = resolve(packageRoot, "docs", "api-report.json");

function assertReport(report, label) {
  if (report === null || typeof report !== "object" || !Array.isArray(report.modules)) {
    throw new Error(`${label} is missing a modules array.`);
  }
}

function moduleMap(report) {
  const map = new Map();
  for (const module of report.modules) {
    if (typeof module?.specifier !== "string") {
      throw new Error("API report module is missing a specifier.");
    }
    map.set(module.specifier, module);
  }
  return map;
}

function exportSet(module) {
  return new Set(Array.isArray(module.exports) ? module.exports : []);
}

function shortHash(value) {
  return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : String(value ?? "");
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function formatNames(label, names) {
  if (names.length === 0) return undefined;
  return `- ${label}: ${names.map((name) => `\`${name}\``).join(", ")}`;
}

/**
 * @param {unknown} baseReport
 * @param {unknown} headReport
 * @returns {{ changed: boolean, markdown: string, removed: string[] }}
 */
export function summarizeApiReportDiff(baseReport, headReport) {
  assertReport(baseReport, "Base API report");
  assertReport(headReport, "Head API report");

  const baseModules = moduleMap(baseReport);
  const headModules = moduleMap(headReport);
  const specifiers = sorted(new Set([...baseModules.keys(), ...headModules.keys()]));
  const sections = [];
  const removals = [];
  const comparable = baseReport.schemaVersion === headReport.schemaVersion;
  const schemaNotes = comparable
    ? []
    : [
        `Surface hashes are not comparable across report schema versions (\`${baseReport.schemaVersion}\` → \`${headReport.schemaVersion}\`); only exported names were compared.`,
        "",
      ];

  for (const specifier of specifiers) {
    const base = baseModules.get(specifier);
    const head = headModules.get(specifier);

    if (!base && head) {
      const added = sorted(exportSet(head));
      sections.push(
        [
          `### \`${specifier}\` (added)`,
          "",
          ...(added.length > 0 ? [formatNames("added exports", added)] : ["- no named exports"]),
        ].join("\n")
      );
      continue;
    }

    if (base && !head) {
      const vanished = sorted(exportSet(base));
      removals.push(`${specifier}: (entrypoint)`);
      for (const name of vanished) removals.push(`${specifier}: ${name}`);
      sections.push(
        [
          `### \`${specifier}\` (removed)`,
          "",
          ...(vanished.length > 0
            ? [formatNames("removed exports", vanished)]
            : ["- no named exports"]),
        ].join("\n")
      );
      continue;
    }

    const baseExports = exportSet(base);
    const headExports = exportSet(head);
    const added = sorted([...headExports].filter((name) => !baseExports.has(name)));
    const removed = sorted([...baseExports].filter((name) => !headExports.has(name)));
    for (const name of removed) removals.push(`${specifier}: ${name}`);
    const hashChanged = comparable && base.sha256 !== head.sha256;

    if (!hashChanged && added.length === 0 && removed.length === 0) continue;

    const lines = [
      `### \`${specifier}\` (${hashChanged ? "hash changed" : "exports changed"})`,
      "",
    ];
    if (hashChanged) {
      lines.push(`- hash: \`${shortHash(base.sha256)}\` → \`${shortHash(head.sha256)}\``);
    }
    if (added.length === 0 && removed.length === 0) {
      lines.push(
        "- public declarations changed (comments and whitespace are ignored); exported names are unchanged. Check for signature changes."
      );
    } else {
      const addedLine = formatNames("added", added);
      const removedLine = formatNames("removed", removed);
      if (addedLine) lines.push(addedLine);
      if (removedLine) lines.push(removedLine);
    }
    sections.push(lines.join("\n"));
  }

  const removed = sorted(removals);

  if (sections.length === 0) {
    return {
      changed: false,
      markdown: [
        "# Public API report",
        "",
        ...schemaNotes,
        "The public API report is unchanged.",
        "",
      ].join("\n"),
      removed,
    };
  }

  return {
    changed: true,
    markdown: [
      "# Public API report",
      "",
      ...schemaNotes,
      "Review this before merge.",
      "",
      ...sections.flatMap((section, index) => (index === 0 ? [section] : ["", section])),
      "",
    ].join("\n"),
    removed,
  };
}

function readJsonFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--removed-only") {
      options["removed-only"] = true;
      continue;
    }
    if (arg === "--base-file" || arg === "--head-file" || arg === "--git-base") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function loadReports(options) {
  if (options["base-file"] || options["head-file"]) {
    if (!options["base-file"] || !options["head-file"]) {
      throw new Error("Both --base-file and --head-file are required.");
    }
    if (options["git-base"]) {
      throw new Error("Use either --base-file/--head-file or --git-base, not both.");
    }
    return {
      base: readJsonFile(resolve(options["base-file"]), "Base API report"),
      head: readJsonFile(resolve(options["head-file"]), "Head API report"),
    };
  }

  const gitBase = options["git-base"] ?? "origin/main";
  const shown = spawnSync("git", ["show", `${gitBase}:docs/api-report.json`], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (shown.status !== 0) {
    throw new Error(
      `git show ${gitBase}:docs/api-report.json failed: ${shown.stderr.trim() || shown.stdout.trim() || `exit ${shown.status}`}`
    );
  }
  let base;
  try {
    base = JSON.parse(shown.stdout);
  } catch (error) {
    throw new Error(
      `Base API report from ${gitBase} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    base,
    head: readJsonFile(reportPath, "Head API report"),
  };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { base, head } = loadReports(options);
    const summary = summarizeApiReportDiff(base, head);
    if (options["removed-only"]) {
      if (summary.removed.length > 0) {
        process.stdout.write(`${summary.removed.join("\n")}\n`);
      }
    } else {
      process.stdout.write(summary.markdown);
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
