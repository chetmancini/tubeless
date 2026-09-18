import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");

const clientEntryPath = resolve(packageRoot, "src/studio/run-store-ui-client-browser.ts");
const browserBundlePath = resolve(packageRoot, "dist/studio/run-store-ui-client-browser.js");

/** Keep compiled ESM intact for the inline module script. */
export function compiledClientSource(js) {
  const withoutMaps = js.replace(/^\uFEFF?\/\/# sourceMappingURL=.*\r?\n?/gm, "");
  if (/\bimport\s*(?:type\s+)?["'{*]/.test(withoutMaps) || /\bimport\s*\(/.test(withoutMaps)) {
    throw new Error("Compiled studio client still contains import; cannot inline.");
  }
  return `${withoutMaps.replace(/\s+$/u, "")}\n`;
}

async function bundledClientSource() {
  if (typeof Bun === "undefined") {
    throw new Error("Generate the Studio client with Bun: bun scripts/generate-studio-client.mjs");
  }
  const result = await Bun.build({
    entrypoints: [clientEntryPath],
    format: "esm",
    minify: true,
    target: "browser",
  });
  if (!result.success || result.outputs.length !== 1) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Studio client bundle failed.${details ? `\n${details}` : ""}`);
  }
  return compiledClientSource(await result.outputs[0].text());
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const source = await bundledClientSource();

  if (check) {
    const actual = existsSync(browserBundlePath)
      ? readFileSync(browserBundlePath, "utf8")
      : undefined;
    if (actual !== source) {
      throw new Error(
        `Generated ${relative(packageRoot, browserBundlePath)} is stale. Run: bun run build`
      );
    }
  } else {
    mkdirSync(dirname(browserBundlePath), { recursive: true });
    writeFileSync(browserBundlePath, source);
    rmSync(`${browserBundlePath}.map`, { force: true });
    process.stdout.write(`Generated ${relative(packageRoot, browserBundlePath)}\n`);
  }
}
