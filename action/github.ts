import { isActionStickyComment, type CommentStore, type StickyComment } from "./report.js";

export const COMMENT_PAGE_SIZE = 100;
export const COMMENT_PAGE_LIMIT = 50;

export interface GitHubClientOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly apiUrl: string;
  readonly repository: string;
  readonly token: string;
  readonly pullRequest: number;
}

function readAuthor(entry: object): string {
  if (!("user" in entry) || typeof entry.user !== "object" || entry.user === null) return "";
  if (!("login" in entry.user) || typeof entry.user.login !== "string") return "";
  return entry.user.login;
}

function redact(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("[redacted]");
}

function apiUrl(base: string, path: string): URL {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//u, ""), root);
}

function repositoryParts(repository: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(repository);
  if (!match || match[1] === undefined || match[2] === undefined)
    throw new Error("GITHUB_REPOSITORY must be owner/name.");
  return { owner: match[1], repo: match[2] };
}

function readComments(value: unknown): StickyComment[] {
  if (!Array.isArray(value)) throw new Error("GitHub comment list was not an array.");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || !("id" in entry))
      throw new Error("GitHub comment list included an invalid entry.");
    const id = entry.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id))
      throw new Error("GitHub comment list included an invalid entry.");
    const body = "body" in entry && typeof entry.body === "string" ? entry.body : "";
    return { id, body, author: readAuthor(entry) };
  });
}

export function createGitHubCommentStore(options: GitHubClientOptions): CommentStore {
  const { owner, repo } = repositoryParts(options.repository);
  const prefix = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${options.token}`);
    headers.set("User-Agent", "tubeless-github-action");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    const response = await options.fetch(apiUrl(options.apiUrl, path), { ...init, headers });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub API ${response.status} for pull request comments: ${redact(text, options.token).slice(0, 500)}`
      );
    }
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("GitHub API returned invalid JSON.");
    }
  };

  return {
    async findSticky(marker) {
      for (let page = 1; page <= COMMENT_PAGE_LIMIT; page += 1) {
        const value = await request(
          `${prefix}/issues/${options.pullRequest}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`
        );
        const batch = readComments(value);
        const match = batch.find((comment) => isActionStickyComment(comment, marker));
        if (match) return match;
        if (batch.length < COMMENT_PAGE_SIZE) return undefined;
      }
      throw new Error(
        `Stopped after ${COMMENT_PAGE_LIMIT * COMMENT_PAGE_SIZE} pull request comments without finding the Tubeless comment. Refusing to post a duplicate.`
      );
    },
    async create(body) {
      await request(`${prefix}/issues/${options.pullRequest}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },
    async update(id, body) {
      await request(`${prefix}/issues/comments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },
  };
}
