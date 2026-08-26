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
): (cwd: string) => T {
  return (cwd: string) =>
    // SAFETY: Object.entries(relativePaths) yields exactly T's keys, and every
    // value is path.join(cwd, relativePath), a string — so the result satisfies
    // T's Record<string, string> constraint.
    Object.fromEntries(
      Object.entries(relativePaths).map(([key, relativePath]) => [
        key,
        path.join(cwd, relativePath),
      ])
    ) as T;
}
