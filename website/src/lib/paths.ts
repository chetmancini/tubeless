export const GITHUB_REPO = "https://github.com/chetmancini/tubeless";
export const GITHUB_BLOB = `${GITHUB_REPO}/blob/main`;
export const GITHUB_RAW = "https://raw.githubusercontent.com/chetmancini/tubeless/main";

export function href(path = ""): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
  const clean = path.replace(/^\/+/, "");
  if (!clean) return base || "/";
  return `${base}/${clean}`;
}

export function githubBlob(repoPath: string): string {
  return `${GITHUB_BLOB}/${repoPath.replace(/^\/+/, "")}`;
}

export function githubRaw(repoPath: string): string {
  return `${GITHUB_RAW}/${repoPath.replace(/^\/+/, "")}`;
}

export function absUrl(path = ""): string {
  const site = (import.meta.env.SITE ?? "https://chetmancini.github.io").replace(/\/+$/, "");
  return `${site}${href(path)}`;
}