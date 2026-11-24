import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { runCloud } from "./index.js";
import { captureIo } from "../../workbench.test-support.js";
import { host, pipeline, baseRun, fixture, service, testDirectory } from "./index.test-support.js";
import type { CliWorkspace, CliRun } from "../protocol.js";

describe("Cloud command", () => {
  it("help makes no HTTP requests", async () => {
    const dependencies = service();
    expect(await runCloud(["run", "--help"], captureIo("/detached"), dependencies)).toBe(0);
    expect(dependencies.calls).toEqual([]);
  });

  it.each([["--input-file", ""], ["--input-file="]])(
    "rejects an explicitly empty input-file path before HTTP: %j",
    async (...flags) => {
      const dependencies = service();
      const io = captureIo("/detached");
      expect(await runCloud(["run", pipeline.slug, ...flags], io, dependencies)).toBe(1);
      expect(dependencies.calls).toHaveLength(0);
      expect(io.errors.join("")).toContain("nonempty --input-file path");
      expect(io.output.join("")).toBe("");
    }
  );
  it("runs deployed code without executing a side-effecting local module", async () => {
    const root = await fixture();
    const marker = path.join(root, "unexpected.txt");
    await writeFile(
      path.join(root, pipeline.name),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('local source must not load');`
    );
    const io = captureIo(root);
    const dependencies = service();
    expect(await runCloud(["run", pipeline.name, "--poll", "--json"], io, dependencies)).toBe(0);
    await expect(access(marker)).rejects.toThrow();
    expect(dependencies.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/v1/session",
      "GET /api/v1/workspaces/workspace/pipelines",
      "POST /api/v1/workspaces/workspace/runs",
      "GET /api/v1/workspaces/workspace/runs/run-1",
    ]);
    expect(JSON.parse(io.output.join(""))).toMatchObject({
      status: "completed",
      commit: "accepted-sha",
    });
    expect(io.errors.join("")).toContain("Local changes are not used");
    expect(io.errors.join("")).toContain("workspace=workspace");
    expect(io.output.join("")).not.toContain("fixture-secret");
  });
  it("explicit IDs work outside a Git repository", async () => {
    const root = await testDirectory();
    const dependencies = service();
    expect(
      await runCloud(
        ["run", "--id", pipeline.id, "--host", host, "--workspace", "workspace", "--detach"],
        captureIo(root),
        dependencies
      )
    ).toBe(0);
  });
  it("unknown or duplicate names never admit", async () => {
    const root = await fixture();
    for (const pipelines of [[], [pipeline, { ...pipeline, id: "other" }]]) {
      const io = captureIo(root);
      const dependencies = service({ pipelines });
      expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(2);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
      expect(io.errors.join("")).toMatch(/cloud list|Multiple pipelines/);
    }
  });
  it("sanitizes human pipeline fields while preserving JSON fields", async () => {
    const remote = `remote\u001b]52;c;clipboard\u0007\u009b31m\u061c\u200e\u200f\u202e\u2066\nspoof`;
    const unsafe = {
      ...pipeline,
      id: remote,
      name: remote,
      slug: remote,
      branch: remote,
      commit: remote,
    };
    const human = captureIo(await fixture());
    expect(await runCloud(["list"], human, service({ pipelines: [unsafe] }))).toBe(0);
    expect(human.output.join("").slice(0, -1)).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
    );
    expect(human.output.join("").split("\n")).toHaveLength(2);
    const machine = captureIo(await fixture());
    expect(await runCloud(["list", "--json"], machine, service({ pipelines: [unsafe] }))).toBe(0);
    expect(JSON.parse(machine.output.join(""))).toEqual([unsafe]);
  });

  it.each([[], ["--follow", "--poll"]])(
    "sanitizes retained and followed logs while preserving JSON %j",
    async (...flags) => {
      const remote = "before\u001b]8;;https://evil.example\u0007link\u009b31m\u202e\nafter";
      const log = { time: 1000, level: "info" as const, message: remote };
      const run = { ...baseRun, status: "completed" as const, logs: [log] };
      const human = captureIo(await fixture());
      expect(await runCloud(["logs", run.id, ...flags], human, service({ runs: [run] }))).toBe(0);
      expect(human.output.join("")).toContain(
        "info: before ]8;;https://evil.example link 31m  after\n"
      );
      const machine = captureIo(await fixture());
      expect(
        await runCloud(["logs", run.id, ...flags, "--json"], machine, service({ runs: [run] }))
      ).toBe(0);
      expect(JSON.parse(machine.output.join("")).logs).toEqual([log]);
    }
  );

  it("sanitizes run progress, results and failures without changing machine snapshots", async () => {
    const remote = "remote\u001b[2J\u009b\u202e\nspoof";
    const run: CliRun = {
      ...baseRun,
      id: remote,
      pipelineName: remote,
      commit: remote,
      status: "failed",
      result: { value: remote },
      error: remote,
    };
    for (const json of [false, true]) {
      const io = captureIo(await fixture());
      expect(
        await runCloud(
          ["run", pipeline.name, "--poll", ...(json ? ["--json"] : [])],
          io,
          service({ admission: run })
        )
      ).toBe(6);
      const human = json ? io.errors.join("") : io.output.join("") + io.errors.join("");
      expect(human).not.toMatch(/[\u001b\u009b\u202e]/);
      expect(human).toContain("Run remote [2J   spoof: remote [2J   spoof\n");
      expect(human).toContain("Source commit: remote [2J   spoof\n");
      if (json) expect(JSON.parse(io.output.join(""))).toEqual(run);
      else expect(io.errors.join("")).toContain("remote [2J   spoof\n");
    }
  });

  it.each([false, true])(
    "redacts bearer keys and values in terminal output (JSON=%s)",
    async (json) => {
      const token = service().env.TUBELESS_TOKEN;
      const run: CliRun = {
        ...baseRun,
        status: "completed",
        result: { "[redacted]": "existing", [token]: { [token]: token } },
      };
      const io = captureIo(await fixture());
      const args = ["run", pipeline.name, "--poll", ...(json ? ["--json"] : [])];
      expect(await runCloud(args, io, service({ admission: run }))).toBe(0);
      const stdout = io.output.join("");
      expect(stdout + io.errors.join("")).not.toContain(token);
      const result = json
        ? JSON.parse(stdout).result
        : JSON.parse(stdout.trimEnd().split("\n").at(-1)!);
      expect(result).toEqual({
        "[redacted]": "existing",
        "[redacted] (2)": { "[redacted]": "[redacted]" },
      });
    }
  );

  it("sanitizes workspace choices and admitted run diagnostics", async () => {
    const remote = "remote\u001b[2J\u009b\u202e\nspoof";
    const choices = service({
      workspaces: [
        { id: remote, name: remote, slug: "workspace", role: "owner" },
        { id: "other", name: "Other", slug: "other", role: "owner" },
      ],
    });
    const selection = captureIo(await fixture());
    expect(await runCloud(["list"], selection, choices)).toBe(2);
    expect(selection.errors.join("")).not.toMatch(/[\u001b\u009b\u202e]/);
    expect(selection.errors.join("")).toContain("Other (other)");
    const dependencies = service({ admission: { ...baseRun, id: remote } });
    const original = dependencies.fetch;
    dependencies.fetch = async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST" ||
      String(url).endsWith("/session") ||
      String(url).endsWith("/pipelines")
        ? original(url, init)
        : Response.json({ error: { code: "not_found", message: remote } }, { status: 404 });
    const failed = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.name, "--poll"], failed, dependencies)).toBe(2);
    expect(failed.errors.join("")).not.toMatch(/[\u001b\u009b\u202e]/);
    expect(failed.errors.join("")).toContain("Run remote [2J   spoof\n");
  });
  it("retains duplicate logs and deduplicates by snapshot array index", async () => {
    const root = await fixture();
    const log = { time: 1000, level: "info" as const, message: "repeated" };
    const dependencies = service({
      runs: [
        { ...baseRun, status: "running", logs: [log, log] },
        { ...baseRun, status: "completed", logs: [log, log] },
      ],
    });
    const io = captureIo(root);
    expect(await runCloud(["logs", "run-1", "--follow", "--poll"], io, dependencies)).toBe(0);
    expect(io.output.join("").match(/repeated/g)).toHaveLength(2);
  });
  it.each([
    ["completed", 0],
    ["failed", 6],
    ["cancelled", 7],
  ] as const)("maps remote %s to %i", async (status, exit) => {
    const root = await fixture();
    const dependencies = service({ runs: [{ ...baseRun, status }] });
    expect(
      await runCloud(["run", pipeline.name, "--poll", "--json"], captureIo(root), dependencies)
    ).toBe(exit);
  });

  describe.each(["run", "logs"] as const)("%s waiting follower", (command) => {
    const args =
      command === "run"
        ? ["run", pipeline.name, "--poll"]
        : ["logs", baseRun.id, "--follow", "--poll"];

    it.each([
      { statuses: ["running", "waiting", "running", "completed"], exit: 0 },
      { statuses: ["waiting", "waiting", "waiting", "waiting", "waiting", "completed"], exit: 0 },
      { statuses: ["waiting", "waiting", "cancelled"], exit: 7 },
      { statuses: ["waiting", "failed"], exit: 6 },
    ] as const)("follows $statuses to exit $exit", async ({ statuses, exit }) => {
      const runs = statuses.map((status): CliRun => ({
        ...baseRun,
        status,
        steps: [{ id: "input", name: "Input", status, durationMs: 0, dependencies: [] }],
      }));
      const sleep = vi.fn(async () => {});
      const dependencies = {
        ...service({ admission: runs[0], runs: command === "run" ? runs.slice(1) : runs }),
        sleep,
      };
      const io = captureIo(await fixture());
      expect(await runCloud([...args, "--json"], io, dependencies)).toBe(exit);
      const final = runs.at(-1)!;
      expect(JSON.parse(io.output.join(""))).toEqual(
        command === "run"
          ? final
          : { id: final.id, pipelineId: final.pipelineId, status: final.status, logs: final.logs }
      );
      expect(sleep.mock.calls).toEqual(
        Array.from({ length: runs.length - 1 }, () => [2000, expect.any(AbortSignal)])
      );
      expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(
        command === "run" ? 1 : 0
      );
      expect(
        dependencies.calls.filter((call) => call.url.endsWith(`/runs/${baseRun.id}`))
      ).toHaveLength(command === "run" ? runs.length - 1 : runs.length);
    });

    it("resets the transport failure budget after waiting polls", async () => {
      const waiting: CliRun = { ...baseRun, status: "waiting" };
      const dependencies = service({
        admission: waiting,
        runs: [waiting, waiting, { ...baseRun, status: "completed" }],
      });
      const original = dependencies.fetch;
      let polls = 0;
      dependencies.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith(`/runs/${baseRun.id}`)) {
          const poll = polls++ - (command === "logs" ? 1 : 0);
          if ([0, 1, 3, 4].includes(poll)) throw new Error("network unavailable");
        }
        return original(url, init);
      };
      const io = captureIo(await fixture());
      expect(await runCloud([...args, "--json"], io, dependencies)).toBe(0);
      expect(JSON.parse(io.output.join(""))).toMatchObject({ status: "completed" });
      expect(polls).toBe(7);
      expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(
        command === "run" ? 1 : 0
      );
    });

    it("interrupts a waiting follower without cancelling remote work", async () => {
      const controller = new AbortController();
      const waiting: CliRun = { ...baseRun, status: "waiting" };
      const dependencies = {
        ...service({ admission: waiting, runs: [waiting] }),
        sleep: async () => {
          controller.abort();
          throw new Error("Aborted");
        },
      };
      const io = { ...captureIo(await fixture()), signal: controller.signal };
      expect(await runCloud([...args, "--json"], io, dependencies)).toBe(7);
      expect(io.output.join("")).toBe("");
      expect(io.errors.join("")).toContain(
        '"recovery":{"host":"https://cloud.tubeless.io","workspaceId":"workspace","runId":"run-1"}'
      );
      expect(io.errors.join("")).toContain("Remote work continues");
      expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(
        command === "run" ? 1 : 0
      );
    });
  });

  it.each(["run", "logs"] as const)("preserves waiting in %s JSON snapshots", async (command) => {
    const waiting: CliRun = {
      ...baseRun,
      status: "waiting",
      steps: [{ id: "input", name: "Input", status: "waiting", durationMs: 0, dependencies: [] }],
    };
    const dependencies = service({ admission: waiting, runs: [waiting] });
    const io = captureIo(await fixture());
    const args = command === "run" ? ["run", pipeline.name, "--detach"] : ["logs", baseRun.id];
    expect(await runCloud([...args, "--json"], io, dependencies)).toBe(0);
    expect(JSON.parse(io.output.join(""))).toEqual(
      command === "run"
        ? waiting
        : { id: waiting.id, pipelineId: waiting.pipelineId, status: "waiting", logs: [] }
    );
  });
  it("interrupting foreground follow prints the run ID without cancellation", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const dependencies = {
      ...service(),
      sleep: async () => {
        controller.abort();
        throw new Error("Aborted");
      },
    };
    const io = { ...captureIo(root), signal: controller.signal };
    expect(await runCloud(["run", pipeline.name, "--poll"], io, dependencies)).toBe(7);
    expect(io.errors.join("")).toContain("Run run-1");
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("stops foreground following after bounded transport failures and keeps the run URL", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/runs/run-1")) throw new Error("network unavailable");
      return original(url, init);
    };
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name, "--poll"], io, dependencies)).toBe(2);
    expect(io.errors.join("")).toContain("Run run-1");
    expect(io.errors.join("")).toContain("/app/runs/run-1?workspace=workspace");
  });
  it.each([
    [403, "forbidden"],
    [404, "not_found"],
  ])("stops logs following on HTTP %i without hiding the run ID", async (status, code) => {
    const root = await fixture();
    const dependencies = service({ runs: [{ ...baseRun, status: "running" }] });
    const original = dependencies.fetch;
    let reads = 0;
    dependencies.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/runs/run-1") && ++reads > 1)
        return Response.json(
          { error: { code, message: "Run is no longer accessible" } },
          { status: Number(status) }
        );
      return original(url, init);
    };
    const io = captureIo(root);
    expect(
      await runCloud(["logs", "run-1", "--follow", "--poll", "--json"], io, dependencies)
    ).toBe(2);
    expect(reads).toBe(2);
    expect(io.output.join("")).toBe("");
    expect(io.errors.join("")).toContain('"runId":"run-1"');
  });
  it("lists slugs, names and IDs before deployment availability", async () => {
    const io = captureIo(await fixture());
    expect(await runCloud(["list"], io, service())).toBe(0);
    expect(io.output.join("")).toBe(
      "orders: Orders (cloud-orders) available commit=stored-sha branch=main\n"
    );
  });
  it.each(["Orders sync", "pipelines/cli.ts"])(
    "treats %s as an exact name without requiring a file",
    async (name) => {
      const root = await fixture();
      const dependencies = service({
        pipelines: [
          { ...pipeline, name, slug: name === "Orders sync" ? "orders-sync" : "pipelines-cli-ts" },
        ],
      });
      expect(await runCloud(["run", name, "--detach"], captureIo(root), dependencies)).toBe(0);
      expect((await readdir(root)).sort()).toEqual([".tubeless"]);
      expect(await readFile(path.join(root, ".tubeless/cloud.json"), "utf8")).toBe(
        "stale malformed project configuration"
      );
    }
  );
  it("requires an exact name or slug and offers IDs for duplicate names", async () => {
    for (const [name, pipelines, diagnostic] of [
      ["ORDERS", [pipeline], "cloud list"],
      ["Orders", [pipeline, { ...pipeline, id: "other" }], "Choose --id"],
    ] as const) {
      const io = captureIo(await fixture());
      const dependencies = service({ pipelines: [...pipelines] });
      expect(await runCloud(["run", name], io, dependencies)).toBe(2);
      expect(io.errors.join("")).toContain(diagnostic);
      expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
      if (pipelines.length > 1) {
        expect(io.errors.join("")).toContain("cloud-orders");
        expect(io.errors.join("")).toContain("other");
        expect(
          await runCloud(
            ["run", "--id", "other", "--detach"],
            captureIo(await fixture()),
            dependencies
          )
        ).toBe(0);
      }
    }
  });
  it("runs by slug and watches retained logs with --poll", async () => {
    const dependencies = service({
      runs: [
        {
          ...baseRun,
          status: "completed",
          logs: [{ time: 1000, level: "info", message: "synced" }],
        },
      ],
    });
    const io = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.slug, "--poll"], io, dependencies)).toBe(0);
    expect(io.output.join("")).toContain("info: synced");
    expect(dependencies.calls.find((call) => call.method === "POST")!.body).toEqual({
      pipelineId: pipeline.id,
      input: {},
    });
    expect(dependencies.calls.some((call) => call.url.endsWith("/runs/run-1"))).toBe(true);
  });
  it("returns the admitted run ID without polling when detached", async () => {
    const dependencies = service();
    const io = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.slug, "--detach", "--json"], io, dependencies)).toBe(0);
    expect(JSON.parse(io.output.join(""))).toMatchObject({ id: "run-1", status: "queued" });
    expect(dependencies.calls.some((call) => call.url.endsWith("/runs/run-1"))).toBe(false);
  });
  it("requires IDs when slugs collide, including an exact-name collision", async () => {
    const dependencies = service({
      pipelines: [
        { ...pipeline, name: "Orders sync", slug: "orders-sync" },
        { ...pipeline, id: "other", name: "orders-sync", slug: "orders-sync" },
      ],
    });
    const io = captureIo(await fixture());
    expect(await runCloud(["run", "orders-sync"], io, dependencies)).toBe(2);
    expect(io.errors.join("")).toContain("cloud-orders");
    expect(io.errors.join("")).toContain("other");
    expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    expect(
      await runCloud(["run", "--id", "other", "--detach"], captureIo(await fixture()), dependencies)
    ).toBe(0);
    expect(dependencies.calls.find((call) => call.method === "POST")!.body).toEqual({
      pipelineId: "other",
      input: {},
    });
  });
  it("fails before listing or admission when automatic workspace selection is unavailable", async () => {
    const second: CliWorkspace = {
      id: "other",
      name: "Other",
      slug: "other",
      role: "owner",
    };
    for (const workspaces of [[], [second, { ...second, id: "third", name: "Third" }]]) {
      for (const args of [["run", pipeline.name], ["list"], ["logs", "run-1"]]) {
        const dependencies = service({ workspaces });
        const io = captureIo(await fixture());
        expect(await runCloud(args, io, dependencies)).toBe(2);
        expect(dependencies.calls.map((call) => call.url)).toEqual(["/api/v1/session"]);
        expect(io.errors.join("")).toContain(workspaces.length ? "--workspace" : "Cloud dashboard");
        if (workspaces.length) expect(io.errors.join("")).toContain("Other (other)");
      }
    }
  });
  it("explicit workspace bypasses session enumeration and remains authoritative", async () => {
    const dependencies = service({ workspaces: [] });
    expect(
      await runCloud(
        ["run", pipeline.name, "--workspace", "chosen", "--detach"],
        captureIo(await fixture()),
        dependencies
      )
    ).toBe(0);
    expect(dependencies.calls.map((call) => call.url)).toEqual([
      "/api/v1/workspaces/chosen/pipelines",
      "/api/v1/workspaces/chosen/runs",
    ]);
  });
  it.each([
    ["link"],
    ["add", "pipeline.ts"],
    ...["export", "pipeline-id", "registry", "repository", "branch", "name", "project"].map(
      (flag) => ["run", "Orders", `--${flag}`, "value"]
    ),
    ["run", "Orders", "--id", "cloud"],
    ["run", "Orders", "--id", ""],
    ["run", "--id", "   "],
    ["run", "Orders", "--workspace", ""],
    ["list", "--workspace", "   "],
    ["list", "--input-file", "input.json"],
    ["list", "--source", "source.json"],
    ["logs", "run-1", "--idempotency-key", "key"],
    ["logs", "run-1", "--cursor", "cursor"],
    ["logs", "run-1", "--poll"],
    ["follow", "run-1", "--poll", "--cursor", "cursor"],
    ["follow", "run-1", "--cursor="],
    ["run", "--id", pipeline.id, "--detach", "--poll"],
    ["run", "--id", pipeline.id, "--source", ""],
    ["run", "--id", pipeline.id, "--source", "@"],
    ["run", "--id", pipeline.id, "--ref", "main", "--source", '{"kind":"ref","ref":"main"}'],
    ["run", "--id", pipeline.id, "--ref", ""],
    ["list", "--ref", "main"],
    ["logs", "run-1", "--ref", "main"],
    ["run", "--id", pipeline.id, "--source-file", "source.json"],
    ["run", "--id", pipeline.id, "--source", "-", "--input-file", "-"],
  ])("rejects obsolete commands and invalid combinations before HTTP: %j", async (...args) => {
    const dependencies = service();
    expect(await runCloud(args, captureIo("/detached"), dependencies)).toBe(1);
    expect(dependencies.calls).toHaveLength(0);
  });
});
