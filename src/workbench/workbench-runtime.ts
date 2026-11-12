/** Runtime requirements shared by the CLI launcher and the workbench. Imports nothing. */

/** Minimum Bun the workbench needs. A test ties this to `engines.bun` in package.json. */
export const MINIMUM_BUN_VERSION = "1.3.14";

/** True when `current` (for example "22.11.0") is at least `minimum` ("22.12.0"); prerelease tags are ignored. */
export function versionAtLeast(current: string, minimum: string): boolean {
  const parse = (version: string) =>
    version.replace(/^v/, "").split("-")[0]!.split(".").map(Number);
  const [a, b] = [parse(current), parse(minimum)];
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** Written to stderr when Node.js starts the launcher but no Bun executable is on `PATH`. */
export function missingBunMessage(): string {
  return (
    `Error: The tubeless CLI needs Bun, and no \`bun\` executable was found on PATH.\n` +
    `Install Bun ${MINIMUM_BUN_VERSION} or later from https://bun.sh, then run the same command again.\n` +
    `The tubeless library itself runs on Node.js and does not need Bun.\n`
  );
}

/** Written to stderr when Bun starts the launcher below the supported minimum. */
export function outdatedBunMessage(found: string): string {
  return (
    `Error: The tubeless CLI needs Bun ${MINIMUM_BUN_VERSION} or later; this is Bun ${found}.\n` +
    `Upgrade with \`bun upgrade\` or from https://bun.sh.\n`
  );
}
