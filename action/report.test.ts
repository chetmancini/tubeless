import { describe, expect, it } from "vitest";
import {
  ACTION_COMMENT_AUTHOR,
  CLOUD_DISPATCH_UNAVAILABLE,
  FOOTER_LINKS,
  cloudRunBlocked,
  commandEnvironment,
  graphArgs,
  isActionStickyComment,
  parseFlag,
  parseMode,
  parsePullRequest,
  planArgs,
  publishStickyComment,
  readRequest,
  renderReport,
  resolveTubelessInvocation,
  runArgs,
  stickyMarker,
  type CommandResult,
  type StickyComment,
} from "./report.js";

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0 });

describe("action report", () => {
  it("defaults to plan and parses flags", () => {
    expect(parseMode(undefined)).toBe("plan");
    expect(parseMode(" dry-run ")).toBe("dry-run");
    expect(() => parseMode("preview")).toThrow(/plan, dry-run, or run/);
    expect(parseFlag(undefined, true)).toBe(true);
    expect(parseFlag("false", true)).toBe(false);
    expect(() => parseFlag("yes", false)).toThrow(/true or false/);
    expect(parsePullRequest("")).toBeUndefined();
    expect(parsePullRequest("17")).toBe(17);
    expect(() => parsePullRequest("0")).toThrow(/pull request/);
  });

  it("reads action inputs without treating an empty token as set", () => {
    expect(
      readRequest({
        INPUT_PIPELINE: " examples/typed-import.ts ",
        INPUT_MODE: "run",
        INPUT_COMMENT: "false",
        INPUT_SUMMARY: "",
        INPUT_CLOUD_TOKEN: "   ",
        PR_NUMBER: "4",
      })
    ).toEqual({
      pipeline: "examples/typed-import.ts",
      mode: "run",
      comment: false,
      summary: true,
      cloudToken: "   ",
      pullRequest: 4,
    });
    expect(cloudRunBlocked("run", "   ")).toBe(false);
    expect(cloudRunBlocked("run", "secret-token")).toBe(true);
    expect(cloudRunBlocked("plan", "secret-token")).toBe(false);
  });

  it("maps modes onto the tubeless CLI", () => {
    expect(planArgs("import", "plan")).toEqual(["plan", "import"]);
    expect(planArgs("import", "dry-run")).toEqual(["plan", "--dry-run", "import"]);
    expect(planArgs("import", "run")).toEqual(["plan", "import"]);
    expect(graphArgs("import")).toEqual(["graph", "import"]);
    expect(runArgs("import", "plan")).toBeUndefined();
    expect(runArgs("import", "dry-run")).toEqual(["run", "import", "--", "--dry-run"]);
    expect(runArgs("import", "run")).toEqual(["run", "import"]);
  });

  it("prefers a local tubeless install, then a built launcher", () => {
    const cwd = "/work";
    expect(resolveTubelessInvocation(cwd, () => false)).toEqual({
      command: "bunx",
      args: ["tubeless"],
    });
    expect(
      resolveTubelessInvocation(cwd, (path) => path.endsWith("node_modules/.bin/tubeless"))
    ).toEqual({ command: `${cwd}/node_modules/.bin/tubeless`, args: [] });
    expect(
      resolveTubelessInvocation(cwd, (path) =>
        path.endsWith("dist/workbench/workbench-launcher.js")
      )
    ).toEqual({
      command: "bun",
      args: [`${cwd}/dist/workbench/workbench-launcher.js`],
    });
  });

  it("drops the cloud token from the CLI environment", () => {
    const env = commandEnvironment({ PATH: "/usr/bin", INPUT_CLOUD_TOKEN: "secret-token" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.INPUT_CLOUD_TOKEN).toBeUndefined();
  });

  it("renders the plan, Mermaid graph, and footer", () => {
    const report = renderReport({
      pipeline: "examples/typed-import.ts",
      mode: "plan",
      plan: ok("import: plan\n  load-rows"),
      graph: ok('flowchart TD\n  load-rows["Load"]'),
      cloudBlocked: false,
    });
    expect(report).toContain(stickyMarker("examples/typed-import.ts"));
    expect(report).toContain("```text\nimport: plan\n  load-rows\n```");
    expect(report).toContain('```mermaid\nflowchart TD\n  load-rows["Load"]\n```');
    expect(report).toContain(FOOTER_LINKS);
    expect(report).toContain("https://tubeless.io");
    expect(report).toContain("https://cloud.tubeless.io");
    expect(report.endsWith(`${FOOTER_LINKS}\n`)).toBe(true);
  });

  it("keeps a cloud token out of the skipped-dispatch report", () => {
    const report = renderReport({
      pipeline: "orders",
      mode: "run",
      plan: ok("plan"),
      graph: ok("flowchart TD"),
      cloudBlocked: true,
    });
    expect(report).toContain(CLOUD_DISPATCH_UNAVAILABLE);
    expect(report).not.toContain("secret-token");
    expect(report).not.toContain("### Run");
  });

  it("includes dry-run execution output and a stable sticky marker", () => {
    const report = renderReport({
      pipeline: "a-->b",
      mode: "dry-run",
      plan: ok("dry plan"),
      graph: ok("flowchart LR"),
      execution: { stdout: "preview", stderr: "warn", exitCode: 0 },
      cloudBlocked: false,
    });
    expect(stickyMarker("a-->b")).toBe('<!-- tubeless-action pipeline="a->b" -->');
    expect(stickyMarker('foo----"bar"')).toBe('<!-- tubeless-action pipeline="foo-_bar_" -->');
    expect(report).toContain('<!-- tubeless-action pipeline="a->b" -->');
    expect(report).toContain("### Dry run");
    expect(report).toContain("preview\nwarn");
  });

  it("updates only the action comment and leaves a quoted copy alone", async () => {
    const created: string[] = [];
    const updated: { id: number; body: string }[] = [];
    const marker = stickyMarker("import");
    const comments: StickyComment[] = [
      { id: 1, body: "unrelated", author: "chet" },
      { id: 3, body: `${marker}\nquoted`, author: "chet" },
      { id: 2, body: `${marker}\nold`, author: ACTION_COMMENT_AUTHOR },
    ];
    const store = {
      async findSticky(nextMarker: string) {
        return comments.find((comment) => isActionStickyComment(comment, nextMarker));
      },
      async create(body: string) {
        created.push(body);
      },
      async update(id: number, body: string) {
        updated.push({ id, body });
      },
    };
    await expect(publishStickyComment(store, "next", marker)).resolves.toBe("updated");
    expect(updated).toEqual([{ id: 2, body: "next" }]);
    expect(created).toEqual([]);

    const fresh = await publishStickyComment(
      {
        async findSticky() {
          return undefined;
        },
        async create(body: string) {
          created.push(body);
        },
        async update() {
          throw new Error("update should not run");
        },
      },
      "first",
      marker
    );
    expect(fresh).toBe("created");
    expect(created).toEqual(["first"]);
    expect(isActionStickyComment(comments[1], marker)).toBe(false);
  });
});
