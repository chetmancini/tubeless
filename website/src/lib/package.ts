import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  name: string;
  version: string;
  license: string;
  type?: string;
  description: string;
  publishConfig?: {
    access?: string;
  };
  engines?: {
    node?: string;
    bun?: string;
  };
  dependencies?: Record<string, string>;
};

const rootPackage = join(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
const pkg = JSON.parse(readFileSync(rootPackage, "utf8")) as PackageJson;

function compactEngine(range: string | undefined): string | undefined {
  return range?.replace(/^>=/, "≥");
}

const publicNpm =
  pkg.publishConfig?.access === "public"
    ? `https://www.npmjs.com/package/${pkg.name}`
    : undefined;

export const PACKAGE = {
  name: pkg.name,
  version: pkg.version,
  license: pkg.license,
  description: pkg.description,
  module: pkg.type === "module" ? "ESM" : (pkg.type ?? "CJS"),
  node: compactEngine(pkg.engines?.node) ?? "Node",
  bun: compactEngine(pkg.engines?.bun),
  runtimeDeps: Object.keys(pkg.dependencies ?? {}).length,
  npm: publicNpm,
} as const;
