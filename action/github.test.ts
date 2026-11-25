import { describe, expect, it } from "vitest";
import { COMMENT_PAGE_LIMIT, COMMENT_PAGE_SIZE, createGitHubCommentStore } from "./github.js";
import { ACTION_COMMENT_AUTHOR, publishStickyComment, stickyMarker } from "./report.js";

interface Recorded {
  url: string;
  method: string;
  body?: string;
  authorization: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub sticky comments", () => {
  it("updates an existing marker comment and redacts the token from API errors", async () => {
    const calls: Recorded[] = [];
    const token = "super-secret-token";
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization: headers.get("Authorization"),
      });
      if (url.startsWith("https://github.example"))
        return jsonResponse({ message: `bad ${token}` }, 422);
      if (url.includes(`/comments?per_page=${COMMENT_PAGE_SIZE}&page=1`)) {
        return jsonResponse([
          {
            id: 9,
            body: `${stickyMarker("import")}\nprevious`,
            user: { login: ACTION_COMMENT_AUTHOR },
          },
        ]);
      }
      if (init?.method === "PATCH") return jsonResponse({ id: 9 });
      return jsonResponse({ message: "unexpected" }, 500);
    };
    const store = createGitHubCommentStore({
      fetch: fetchImpl,
      apiUrl: "https://api.github.com",
      repository: "chetmancini/tubeless",
      token,
      pullRequest: 12,
    });

    await expect(publishStickyComment(store, "next body", stickyMarker("import"))).resolves.toBe(
      "updated"
    );
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/chetmancini/tubeless/issues/12/comments?per_page=100&page=1"
    );
    expect(calls[0]?.authorization).toBe(`Bearer ${token}`);
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/chetmancini/tubeless/issues/comments/9"
    );
    expect(calls[1]?.body).toBe(JSON.stringify({ body: "next body" }));

    const failing = createGitHubCommentStore({
      fetch: fetchImpl,
      apiUrl: "https://github.example/api/v3",
      repository: "acme/widgets",
      token,
      pullRequest: 3,
    });
    await expect(failing.findSticky(stickyMarker("import"))).rejects.toThrow(/\[redacted\]/);
    await expect(failing.findSticky(stickyMarker("import"))).rejects.toThrow(/GitHub API 422/);
    await expect(failing.findSticky(stickyMarker("import"))).rejects.not.toThrow(
      /super-secret-token/
    );
    expect(calls.at(-1)?.url).toContain("https://github.example/api/v3/repos/acme/widgets/");
  });

  it("pages through comments and creates one when the marker is absent", async () => {
    const posted: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("page=1")) {
        return jsonResponse(
          Array.from({ length: COMMENT_PAGE_SIZE }, (_, id) => ({
            id,
            body: "other",
            user: { login: "chet" },
          }))
        );
      }
      if (url.endsWith("page=2")) return jsonResponse([]);
      posted.push(typeof init?.body === "string" ? init.body : "");
      return jsonResponse({ id: 101 });
    };
    const store = createGitHubCommentStore({
      fetch: fetchImpl,
      apiUrl: "https://api.github.com/",
      repository: "chetmancini/tubeless",
      token: "token",
      pullRequest: 4,
    });
    await expect(publishStickyComment(store, "created", stickyMarker("import"))).resolves.toBe(
      "created"
    );
    expect(posted).toEqual([JSON.stringify({ body: "created" })]);
  });

  it("creates a new comment when a person only quoted the marker", async () => {
    const methods: string[] = [];
    const marker = stickyMarker("import");
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET") {
        return jsonResponse([{ id: 3, body: `${marker}\nquoted`, user: { login: "chet" } }]);
      }
      return jsonResponse({ id: 4 });
    };
    const store = createGitHubCommentStore({
      fetch: fetchImpl,
      apiUrl: "https://api.github.com",
      repository: "chetmancini/tubeless",
      token: "token",
      pullRequest: 8,
    });
    await expect(publishStickyComment(store, "fresh", marker)).resolves.toBe("created");
    expect(methods).toEqual(["GET", "POST"]);
  });

  it("refuses to post a duplicate when the comment scan stays full", async () => {
    let posts = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        posts += 1;
        return jsonResponse({ id: 1 });
      }
      return jsonResponse(
        Array.from({ length: COMMENT_PAGE_SIZE }, (_, index) => ({
          id: index,
          body: "other",
          user: { login: "chet" },
        }))
      );
    };
    const store = createGitHubCommentStore({
      fetch: fetchImpl,
      apiUrl: "https://api.github.com",
      repository: "chetmancini/tubeless",
      token: "token",
      pullRequest: 9,
    });
    await expect(publishStickyComment(store, "fresh", stickyMarker("import"))).rejects.toThrow(
      new RegExp(String(COMMENT_PAGE_LIMIT * COMMENT_PAGE_SIZE))
    );
    expect(posts).toBe(0);
  });
});
