import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const binary = process.argv[2];
const token = "packed-fixture-session";
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
const routes = [];
const server = createServer(async (request, response) => {
  routes.push(`${request.method} ${request.url}`);
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  response.setHeader("Content-Type", "application/json");
  const send = (value, status = 200) => {
    response.statusCode = status;
    response.end(JSON.stringify(value));
  };
  if (request.url === "/api/v1/session")
    return send({
      user: { id: "user", login: "user", name: "User", email: "user@example.com", avatar: "" },
      expiresAt: Date.now() + 60000,
      workspaces: [
        {
          id: "workspace",
          name: "Workspace",
          slug: "workspace",
          role: "owner",
        },
      ],
    });
  if (request.url.endsWith("/pipelines")) return send([pipeline]);
  if (request.url.endsWith("/runs") && request.method === "POST") {
    assert.ok(request.headers["idempotency-key"]);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { pipelineId: "packed", input: {} });
    return send(run, 202);
  }
  if (request.url.endsWith("/runs/packed-run")) return send(run);
  send({ error: { code: "not_found", message: "Unknown fixture route" } }, 404);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const command = async (args) => {
  const result = await promisify(execFile)(binary, args, {
    env: { ...process.env, TUBELESS_TOKEN: token },
    timeout: 10000,
  });
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
  return JSON.parse(result.stdout);
};
try {
  const status = await command(["auth", "status", "--host", origin, "--json"]);
  assert.equal(status.credentialSource, "environment");
  const pipelines = await command(["cloud", "list", "--host", origin, "--json"]);
  assert.equal(pipelines[0].name, "Packed Cloud");
  assert.equal(pipelines[0].slug, "packed-cloud");
  const accepted = await command([
    "cloud",
    "run",
    pipeline.slug,
    "--host",
    origin,
    "--detach",
    "--json",
  ]);
  assert.equal(accepted.commit, "deployed-fixture");
  const logs = await command([
    "cloud",
    "logs",
    "packed-run",
    "--workspace",
    "workspace",
    "--host",
    origin,
    "--json",
  ]);
  assert.equal(logs.logs[0].message, "packed log");
  assert.deepEqual(routes, [
    "GET /api/v1/session",
    "GET /api/v1/session",
    "GET /api/v1/workspaces/workspace/pipelines",
    "GET /api/v1/session",
    "GET /api/v1/workspaces/workspace/pipelines",
    "POST /api/v1/workspaces/workspace/runs",
    "GET /api/v1/workspaces/workspace/runs/packed-run",
  ]);
} finally {
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
}
