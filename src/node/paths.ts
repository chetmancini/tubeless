import * as path from "path";

/**
 * Declares a set of workspace-relative default paths as one factory instead of one
 * `function defaultXDir(cwd) { return path.join(cwd, "...") }` per path. The returned
 * function re-resolves against `cwd` on every call — nothing is computed or cached at
 * module-load time, so a frozen-`process.cwd()` bug cannot be reintroduced by
 * construction.
 */
export function definePaths<T extends Record<string, string>>(
  relativePaths: T
): (cwd: string) => { [K in keyof T]: string } {
  return (cwd: string) =>
    // SAFETY: Object.entries(relativePaths) yields exactly T's keys, and every
    // value is a resolved string, so the result preserves T's keys while widening
    // relative path literals to string.
    Object.fromEntries(
      Object.entries(relativePaths).map(([key, relativePath]) => [
        key,
        path.join(cwd, relativePath),
      ])
    ) as { [K in keyof T]: string };
}
