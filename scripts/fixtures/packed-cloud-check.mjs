import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.argv[2];
const token = "packed-fixture-session";
const automationToken = "tlc_ci_v1.packed-test-only";
const root = await mkdtemp(join(tmpdir(), "tubeless-packed-automation-"));
const pipeline = {
  id: "packed",
  name: "Packed Cloud",
  slug: "packed-cloud",
  branch: "main",
  commit: "deployed-fixture",
  enabled: true,
  available: true,
};
const run = {
  id: "packed-run",
  pipelineId: pipeline.id,
  pipelineName: pipeline.name,
  status: "completed",
  createdAt: 1000,
  durationMs: 1,
  commit: pipeline.commit,
  branch: "main",
  trigger: "manual",
  actor: "user",
  steps: [],
  logs: [{ time: 1000, level: "info", message: "packed log" }],
  artifacts: [],
  input: {},
  result: 42,
};
const base = "/api/v1/workspaces/workspace";
const session = {
  method: "GET",
  path: "/api/v1/session",
  responseBody: {
    user: { id: "user", login: "user", name: "User", email: "user@example.com", avatar: "" },
    expiresAt: Date.now() + 60000,
    workspaces: [{ id: "workspace", name: "Workspace", slug: "workspace", role: "owner" }],
  },
};
const inventory = { method: "GET", path: `${base}/pipelines`, responseBody: [pipeline] };

// Assert executable HTTP exchanges only. Cloud integration tests own admission policy.
const exchanges = [];
const server = createServer(async (request, response) => {
  const expected = exchanges.shift();
  assert.ok(expected, `Unexpected request: ${request.method} ${request.url}`);
  assert.equal(request.method, expected.method);
  assert.equal(request.url, expected.path);
  assert.equal(request.headers.authorization, `Bearer ${expected.token}`);
  assert.equal(request.headers.cookie, undefined);
  let text = "";
  for await (const chunk of request) text += chunk;
  assert.deepEqual(text ? JSON.parse(text) : undefined, expected.requestBody);
  if (expected.method === "POST") {
    assert.ok(request.headers["idempotency-key"]);
    if (expected.key) assert.equal(request.headers["idempotency-key"], expected.key);
  }
  if (expected.disconnect) {
    request.socket.destroy();
    return;
  }
  response.writeHead(expected.status ?? 200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(expected.responseBody));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const command = async (args, script, bearer = token, stdin) => {
  exchanges.push(...script.map((step) => ({ ...step, token: bearer })));
  const execution = promisify(execFile)(binary, args, {
    env: { ...process.env, TUBELESS_TOKEN: bearer },
    cwd: root,
    timeout: 10000,
  });
  if (stdin !== undefined) execution.child.stdin.end(stdin);
  try {
    const result = await execution;
    assert.ok(!result.stdout.includes(bearer) && !result.stderr.includes(bearer));
    return JSON.parse(result.stdout);
  } finally {
    assert.equal(exchanges.length, 0, "The executable did not perform every expected exchange");
  }
};
try {
  const status = await command(["auth", "status", "--host", origin, "--json"], [session]);
  assert.equal(status.credentialSource, "environment");
  const pipelines = await command(
    ["cloud", "list", "--host", origin, "--json"],
    [session, inventory]
  );
  assert.equal(pipelines[0].slug, "packed-cloud");
  const accepted = await command(
    ["cloud", "run", pipeline.slug, "--host", origin, "--detach", "--json"],
    [
      session,
      inventory,
      {
        method: "POST",
        path: `${base}/runs`,
        requestBody: { pipelineId: pipeline.id, input: {} },
        responseBody: run,
        status: 202,
      },
    ]
  );
  assert.equal(accepted.commit, run.commit);
  const explicit = ["--workspace", "workspace", "--host", origin, "--json"];
  const read = { method: "GET", path: `${base}/runs/${run.id}`, responseBody: run };
  const logs = await command(["cloud", "logs", run.id, ...explicit], [read]);
  assert.equal(logs.logs[0].message, "packed log");
  await command(["cloud", "list", ...explicit], [inventory], automationToken);
  await command(["cloud", "logs", run.id, ...explicit], [read], automationToken);

  const source = { kind: "main", commit: "a".repeat(40) };
  await writeFile(
    join(root, "source.json"),
    JSON.stringify({ ...source, commit: source.commit.toUpperCase() })
  );
  const args = [
    "cloud",
    "run",
    "--id",
    pipeline.id,
    ...explicit,
    "--detach",
    "--source",
    "@source.json",
    "--idempotency-key",
    "packed.fixed",
  ];
  const receipt = { ...run, status: "queued", commit: source.commit };
  const admission = {
    method: "POST",
    path: `${base}/runs`,
    key: "packed.fixed",
    requestBody: { pipelineId: pipeline.id, input: {}, source },
    responseBody: receipt,
    status: 202,
  };
  // The second POST must preserve the complete intent after a lost response.
  const first = await command(
    args,
    [{ ...admission, disconnect: true }, admission],
    automationToken
  );
  assert.deepEqual(first, receipt);
  assert.deepEqual(await command(args, [admission], automationToken), receipt);
  const inline = [...args];
  inline[inline.indexOf("--source") + 1] = JSON.stringify(source);
  assert.deepEqual(await command(inline, [admission], automationToken), receipt);
  const stdin = [...inline];
  stdin[stdin.indexOf("--source") + 1] = "-";
  assert.deepEqual(
    await command(stdin, [admission], automationToken, JSON.stringify(source)),
    receipt
  );

  for (const ref of ["feature/orders", "tags/v1.2.3", "eeeeeee"]) {
    const refArgs = [
      "cloud",
      "run",
      "--id",
      pipeline.id,
      ...explicit,
      "--detach",
      "--ref",
      ref,
      "--idempotency-key",
      "packed.ref",
    ];
    const responseBody = { ...receipt, commit: "e".repeat(40) };
    const selected = await command(
      refArgs,
      [
        {
          ...admission,
          key: "packed.ref",
          requestBody: {
            pipelineId: pipeline.id,
            input: {},
            source: { kind: "ref", ref },
          },
          responseBody,
        },
      ],
      automationToken
    );
    assert.equal(selected.commit, responseBody.commit);
  }
  for (const [status, code, exit] of [
    [403, "forbidden", 2],
    [409, "conflict", 6],
  ]) {
    await assert.rejects(
      command(
        args,
        [
          {
            ...admission,
            status,
            responseBody: { error: { code, message: "Controlled rejection" } },
          },
        ],
        automationToken
      ),
      (error) => error.code === exit && !error.stderr.includes(automationToken)
    );
  }
} finally {
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  await rm(root, { recursive: true, force: true });
}
