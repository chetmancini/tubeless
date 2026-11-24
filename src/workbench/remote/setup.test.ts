import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { it, expect, vi } from "vitest";
import { runRemote } from "../workbench-remote.js";
import { CLOUDFLARE_DEV_DEPENDENCIES } from "../workbench-init-cloudflare.js";
import { baseRun, pipeline, service, testDirectory } from "../cloud/command/index.test-support.js";
import { FOLLOW_MEDIA_TYPE } from "../cloud/follow-protocol.js";
import type { RemoteProcess } from "./process.js";

const worker = "https://jobs.example.test";
const configInfo = {
  projectId: "jobs",
  deploymentId: "release-1",
};
async function fixture() {
  const cwd = await testDirectory();
  const config = join(cwd, "config");
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    cwd,
    stdout: { write: (chunk: string) => void output.push(chunk) },
    stderr: { write: (chunk: string) => void errors.push(chunk) },
  };
  return { io, output, errors, config, env: { XDG_CONFIG_HOME: config } };
}

it("discovers a Cloudflare Worker and uses the saved alias without persisting its credentials", async () => {
  const { io, output, errors, config, env } = await fixture();
  const execute: RemoteProcess = vi.fn(async ({ args }) => {
    if (args.includes("durable-objects"))
      return JSON.stringify([
        { class: "TubelessStudio", script: "jobs" },
        { class: "TubelessRun", script: "jobs" },
      ]);
    expect(args).toContain("workers");
    return JSON.stringify([
      { name: "jobs", references: { domains: [{ hostname: "jobs.example.test" }] } },
    ]);
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(configInfo))
    .mockResolvedValueOnce(Response.json({ executionId: "admitted" }, { status: 202 }));
  const deps = {
    execute,
    fetch,
    env: {
      ...env,
      CLOUDFLARE_API_TOKEN: "management",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CF_ACCESS_CLIENT_ID: "client",
      CF_ACCESS_CLIENT_SECRET: "private-access-key",
    },
  };
  expect(
    await runRemote(["connect", "--provider", "cloudflare", "--name", "production"], io, deps),
    errors.join("")
  ).toBe(0);
  expect(fetch.mock.calls[0][0]).toBe(worker + "/api/executions/v1");
  expect(
    await runRemote(["run", "ingest", "--remote", "production", "--detach", "--json"], io, deps),
    errors.join("")
  ).toBe(0);
  expect(fetch.mock.calls[1][0]).toBe(worker + "/api/executions/v1");
  expect(output.at(-1)).toBe('{"executionId":"admitted"}\n');
  const saved = await readFile(join(config, "tubeless/remotes/production.json"), "utf8");
  expect(saved).not.toContain("private-access-key");
  expect(saved).not.toContain("management");
});

it("connects to a Worker that predates collection metadata", async () => {
  const { io, env, errors, output } = await fixture();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ code: "execution_not_found" }, { status: 404 }));
  expect(
    await runRemote(["connect", "http://localhost:8787", "--json"], io, { env, fetch }),
    errors.join("")
  ).toBe(0);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "http://localhost:8787/api/executions/v1",
    expect.any(Object)
  );
  expect(JSON.parse(output[0])).toMatchObject({ name: "localhost", provider: "cloudflare" });
});

it("opens Cloudflare Access login on first connect and keeps the browser token out of output", async () => {
  const { io, errors, output, env } = await fixture();
  let signedIn = false;
  const execute: RemoteProcess = vi.fn(async ({ args, interactive }) => {
    if (args[1] === "login") {
      expect(args).toContain("--quiet");
      expect(interactive).toBe(true);
      signedIn = true;
      return "";
    }
    expect(args[1]).toBe("token");
    return signedIn ? "token.payload.signature" : "";
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
    expect(new Headers(options?.headers).get("cf-access-token")).toBe("token.payload.signature");
    return Response.json(configInfo);
  });
  const interactive = { ...io, stdin: Object.assign(new PassThrough(), { isTTY: true }) };
  expect(
    await runRemote(["connect", worker, "--name", "jobs", "--json"], interactive, {
      execute,
      fetch,
      env,
    }),
    errors.join("")
  ).toBe(0);
  expect(output.join("")).not.toContain("token.payload.signature");
});

it("creates a Cloud remote from the selected workspace and routes runs through the Cloud client", async () => {
  const { io, env, errors, output } = await fixture();
  const { fetch: fetcher, calls } = service();
  const deps = { env: { ...env, TUBELESS_TOKEN: "test-session-token" }, fetch: fetcher };
  expect(
    await runRemote(
      ["create", "--provider", "tubeless-cloud", "--workspace", "workspace", "--name", "cloud"],
      io,
      deps
    ),
    errors.join("")
  ).toBe(0);
  expect(await runRemote(["run", "orders", "--detach", "--json"], io, deps), errors.join("")).toBe(
    0
  );
  expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
    pipelineId: "cloud-orders",
  });
  expect(JSON.parse(output.at(-1) ?? "{}").id).toBe("run-1");
  expect(
    await runRemote(["status", "run-1", "--follow", "--poll", "--json"], io, deps),
    errors.join("")
  ).toBe(0);
  expect(JSON.parse(output.at(-1) ?? "{}").status).toBe("completed");
});

it("streams foreground runs and followed status through a saved Cloud remote", async () => {
  const { io, env, errors, output } = await fixture();
  const run = { ...baseRun, id: "worker-live", pipelineId: "check" };
  const workspace = {
    id: "fixture-workspace",
    name: "Workspace",
    slug: "workspace",
    role: "owner",
  } as const;
  const cloud = service({
    workspaces: [workspace],
    pipelines: [{ ...pipeline, id: run.pipelineId }],
    admission: run,
    runs: [{ ...run, status: "completed" }],
  });
  const events = await readFile(
    new URL("../../../fixtures/cloud-run-follow/v1/worker-live.ndjson", import.meta.url),
    "utf8"
  );
  const deps = {
    ...cloud,
    env: { ...env, ...cloud.env },
    fetch: vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (url.endsWith(`/runs/${run.id}/events`))
        return new Response(events, { headers: { "content-type": FOLLOW_MEDIA_TYPE } });
      const response = await cloud.fetch(request, init);
      if (!url.endsWith("/session")) return response;
      return Response.json({
        ...((await response.json()) as Record<string, unknown>),
        runFollowing: { version: 1, transport: "ndjson" },
      });
    }),
  };
  expect(
    await runRemote(["connect", "--workspace", workspace.id, "--name", "cloud"], io, deps),
    errors.join("")
  ).toBe(0);
  for (const args of [
    ["run", "orders"],
    ["status", run.id, "--follow"],
  ]) {
    expect(
      await runRemote([...args, "--remote", "cloud", "--json"], io, deps),
      errors.join("")
    ).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({ id: run.id, status: "completed" });
  }
  expect(
    deps.fetch.mock.calls.filter(([request]) => String(request).endsWith("/events"))
  ).toHaveLength(2);
});

it.each(["first deployment", "resume with a changed Access audience"] as const)(
  "configures and verifies the Cloudflare remote during %s",
  async (phase) => {
    const { io, env, errors, config } = await fixture();
    const resuming = phase !== "first deployment";
    const from = (path: string) => JSON.stringify(pathToFileURL(resolve("dist", path)).href);
    await writeFile(
      join(io.cwd, "jobs.mjs"),
      `
    import { createSteps, definePipeline } from ${from("core/pipeline.js")};
    import { definePipelineCommand } from ${from("cli/cli.js")};
    import { defineProject } from ${from("project/project.js")};
    const { step } = createSteps();
    const jobs = definePipeline({ id: "ingest", steps: [step("hello", {run: () => "hello"})] });
    export default defineProject("jobs", [definePipelineCommand(jobs, { params: {} })]);
  `
    );
    await writeFile(
      join(io.cwd, "package.json"),
      JSON.stringify({ name: "tubeless", devDependencies: CLOUDFLARE_DEV_DEPENDENCIES })
    );
    await mkdir(join(io.cwd, "node_modules/.bin"), { recursive: true });
    await writeFile(join(io.cwd, "node_modules/.bin/cf"), "");
    if (resuming) {
      await mkdir(join(io.cwd, "cloudflare"));
      await writeFile(join(io.cwd, "cloudflare.config.ts"), "");
      await writeFile(
        join(io.cwd, "cloudflare/remote.json"),
        JSON.stringify({
          name: "jobs",
          accountId: "account",
          teamDomain: "team.cloudflareaccess.com",
          audience: "stale-audience",
        })
      );
    }
    let deploys = 0;
    let policy: unknown;
    const execute: RemoteProcess = vi.fn(async ({ command, args }) => {
      if (command === "node") return "v24.0.0";
      if (command === "cloudflared") return "token.payload.signature";
      if (args.includes("organization"))
        return JSON.stringify({ auth_domain: "team.cloudflareaccess.com" });
      if (args.includes("durable-objects"))
        return JSON.stringify([
          { class: "TubelessStudio", script: "jobs" },
          { class: "TubelessRun", script: "jobs" },
        ]);
      if (args.includes("workers") && args.includes("list"))
        return JSON.stringify(
          !resuming && deploys === 0
            ? []
            : [
                {
                  id: "worker-id",
                  name: "jobs",
                  subdomain: { enabled: true, url: worker },
                },
              ]
        );
      if (args.includes("deploy")) {
        deploys++;
        const settings = JSON.parse(await readFile(join(io.cwd, "cloudflare/remote.json"), "utf8"));
        expect(settings.audience).toBe(!resuming && deploys === 1 ? "" : "my-audience");
        return "";
      }
      if (args.includes("applications") && args.includes("list"))
        return JSON.stringify(
          resuming
            ? [
                {
                  name: "Tubeless jobs",
                  destinations: [{ type: "worker", worker_id: "worker-id" }],
                  aud: "my-audience",
                },
              ]
            : []
        );
      if (args.includes("applications") && args.includes("create")) {
        policy = JSON.parse(args[args.indexOf("--body") + 1]);
        return JSON.stringify({ aud: "my-audience" });
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      expect(deploys).toBe(resuming ? 1 : 2);
      expect(new Headers(options?.headers).get("cf-access-token")).toBe("token.payload.signature");
      return Response.json(configInfo);
    });
    expect(
      await runRemote(
        [
          "create",
          "--provider",
          "cloudflare",
          "--name",
          "jobs",
          "--account",
          "account",
          "--project",
          "jobs.mjs",
          "--email",
          "user@example.test",
          "--yes",
        ],
        io,
        { execute, fetch, env: { ...env, CLOUDFLARE_API_TOKEN: "management" } }
      ),
      errors.join("")
    ).toBe(0);
    if (resuming) expect(policy).toBeUndefined();
    else
      expect(policy).toMatchObject({
        destinations: [{ type: "worker", worker_id: "worker-id" }],
        policies: [{ decision: "allow", include: [{ email: { email: "user@example.test" } }] }],
      });
    expect(await readFile(join(config, "tubeless/remotes/jobs.json"), "utf8")).not.toContain(
      "token.payload.signature"
    );
  }
);
