import type { CommentStore } from "./report.js";

export interface GitHubClientOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly apiUrl: string;
  readonly repository: string;
  readonly token: string;
  readonly pullRequest: number;
}

interface GitHubComment {
  readonly id: number;
  readonly body: string;
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

function readComments(value: unknown): GitHubComment[] {
  if (!Array.isArray(value)) throw new Error("GitHub comment list was not an array.");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || !("id" in entry))
      throw new Error("GitHub comment list included an invalid entry.");
    const id = entry.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id))
      throw new Error("GitHub comment list included an invalid entry.");
    const body = "body" in entry && typeof entry.body === "string" ? entry.body : "";
    return { id, body };
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
    async list() {
      const comments: GitHubComment[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const value = await request(
          `${prefix}/issues/${options.pullRequest}/comments?per_page=100&page=${page}`
        );
        const batch = readComments(value);
        comments.push(...batch);
        if (batch.length < 100) break;
      }
      return comments;
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
