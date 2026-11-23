import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const pairedRoot = new URL("../../fixtures/cloud-run-follow/v1/", import.meta.url);
const paired = JSON.parse(await readFile(new URL("exchanges.json", pairedRoot), "utf8"));
const pairedRuns = `/api/v1/workspaces/${paired.workspaceId}/runs`;

// Assert executable HTTP exchanges only. Cloud integration tests own admission policy.
const exchanges = [];
const server = createServer(async (request, response) => {
  const expected = exchanges.shift();
  assert.ok(expected, `Unexpected request: ${request.method} ${request.url}`);
  assert.equal(request.method, expected.method);
  assert.equal(request.url, expected.path);
  assert.equal(request.headers.authorization, `Bearer ${expected.token}`);
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers.accept, expected.accept ?? "application/json");
  let text = "";
  for await (const chunk of request) text += chunk;
  assert.deepEqual(text ? JSON.parse(text) : undefined, expected.requestBody);
  if (expected.method === "POST") {
    assert.ok(request.headers["idempotency-key"]);
    if (expected.key) assert.equal(request.headers["idempotency-key"], expected.key);
  } else assert.equal(request.headers["idempotency-key"], undefined);
  if (expected.disconnect) {
    request.socket.destroy();
    return;
  }
  response.writeHead(expected.status ?? 200, {
    "Content-Type": expected.contentType ?? "application/json",
  });
  if (expected.hold) response.write(expected.raw);
  else response.end(expected.raw ?? JSON.stringify(expected.responseBody));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const execute = async (args, script, bearer = token, { stdin, exit = 0, interruptOn } = {}) => {
  exchanges.push(...script.map((step) => ({ ...step, token: bearer })));
  const execution = promisify(execFile)(binary, args, {
    env: { ...process.env, TUBELESS_TOKEN: bearer },
    cwd: root,
    timeout: 10000,
  });
  if (stdin !== undefined) execution.child.stdin.end(stdin);
  if (interruptOn) {
    let received = "";
    const interrupt = (chunk) => {
      received += chunk;
      if (received.includes(interruptOn)) {
        execution.child.stderr.off("data", interrupt);
        execution.child.kill("SIGINT");
      }
    };
    execution.child.stderr.on("data", interrupt);
  }
  try {
    const result = await execution.catch((error) => {
      if (exit === 0) throw error;
      assert.equal(error.code, exit, error.stderr);
      return error;
    });
    assert.equal(result.code ?? 0, exit);
    assert.ok(!result.stdout.includes(bearer) && !result.stderr.includes(bearer));
    return result;
  } finally {
    assert.equal(exchanges.length, 0, "The executable did not perform every expected exchange");
  }
};
const command = async (args, script, bearer, stdin) =>
  JSON.parse((await execute(args, script, bearer, { stdin })).stdout);

function response(exchange, body = exchange.body) {
  return { ...exchange, responseBody: body };
}
function diagnostics({ stderr }) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}
async function followFixture(name) {
  const { runId, cursor, bodyFile } = paired.stream.exchanges.find(
    ({ bodyFile }) => bodyFile === name
  );
  const path = paired.stream.pathTemplate
    .replace("{workspaceId}", paired.workspaceId)
    .replace("{runId}", runId);
  const body = await readFile(new URL(bodyFile, pairedRoot), "utf8");
  const lines = body.trimEnd().split("\n");
  const events = lines.map((line) => JSON.parse(line));
  const last = events.at(-1);
  return {
    runId,
    path,
    lines,
    events,
    stream: {
      method: paired.stream.method,
      path: cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
      accept: paired.stream.accept,
      status: paired.stream.status,
      contentType: paired.stream.contentType,
      raw: body,
    },
    terminal: last.type === "terminal" ? { ...run, ...last.payload.run } : undefined,
  };
}
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
    await execute(
      args,
      [
        {
          ...admission,
          status,
          responseBody: { error: { code, message: "Controlled rejection" } },
        },
      ],
      automationToken,
      { exit }
    );
  }

  const pairedFlags = ["--workspace", paired.workspaceId, "--host", origin];
  const discover = response(paired.discovery.automation);
  const interactive = response(paired.discovery.interactive);
  const fullRead = (terminal) => ({
    method: "GET",
    path: `${pairedRuns}/${terminal.id}`,
    responseBody: terminal,
  });
  const attach = (id, ...flags) => ["cloud", "follow", id, ...pairedFlags, ...flags];
  const live = await followFixture("worker-live.ndjson");
  const submit = {
    method: "POST",
    path: pairedRuns,
    requestBody: { pipelineId: "check", input: {} },
    responseBody: { ...live.terminal, ...live.events[0].payload.run },
    status: 202,
  };
  // Healthy CLI observation performs one GET for the full retained result.
  assert.deepEqual(
    await command(
      ["cloud", "run", "--id", "check", ...pairedFlags, "--json"],
      [submit, discover, live.stream, fullRead(live.terminal)],
      automationToken
    ),
    live.terminal
  );
  const human = await execute(attach(live.runId), [
    interactive,
    live.stream,
    fullRead(live.terminal),
  ]);
  assert.match(human.stdout, /waiting\n[\s\S]*running\n[\s\S]*completed\n/);
  assert.equal(human.stdout.match(/Checking café/g)?.length, 2);
  const unsafeLog = `before\u001b[2J\u202e\n${automationToken} after`;
  const unsafe = await execute(
    attach(live.runId),
    [
      discover,
      {
        ...live.stream,
        raw: live.stream.raw.replace("Checking café", JSON.stringify(unsafeLog).slice(1, -1)),
      },
      fullRead(live.terminal),
    ],
    automationToken
  );
  assert.match(unsafe.stdout, /info: before \[2J {2}\[redacted\] after\n/);
  assert.doesNotMatch(unsafe.stdout, /[\u001b\u202e]/);

  // EOF in a partial record keeps the last processed cursor. The reconnect
  // replay of log position 1 is skipped, and the identical message at 2 is new.
  const midLine = {
    ...live.stream,
    raw: live.lines.slice(0, 3).join("\n") + '\n{"version":',
  };
  const liveCursor = live.events[2].cursor;
  const resumed = {
    ...live.stream,
    path: `${live.path}?cursor=${liveCursor}`,
    raw: [
      JSON.stringify({ ...live.events[0], cursor: liveCursor, payload: live.events[1].payload }),
      ...live.lines.slice(2),
      "",
    ].join("\n"),
  };
  const reconnected = await execute(
    ["cloud", "run", "--id", "check", ...pairedFlags],
    [submit, discover, midLine, resumed, fullRead(live.terminal)],
    automationToken
  );
  assert.equal(reconnected.stdout.match(/Checking café/g)?.length, 2);

  for (const [file, exit] of [
    ["native-failure.ndjson", 6],
    ["cancelled.ndjson", 7],
    ["interrupted.ndjson", 6],
  ]) {
    const scenario = await followFixture(file);
    const result = await execute(
      attach(scenario.runId, "--json"),
      [discover, scenario.stream, fullRead(scenario.terminal)],
      automationToken,
      { exit }
    );
    assert.deepEqual(JSON.parse(result.stdout), scenario.terminal);
    if (file === "interrupted.ndjson")
      assert.deepEqual(diagnostics(result), [
        { type: "cloud_follow_terminal", outcome: "interrupted" },
      ]);
  }
  const backpressure = await followFixture("backpressure.ndjson");
  const resumedBacklog = await followFixture("resume.ndjson");
  const hydrated = { ...resumedBacklog.terminal, result: { fromFullRead: true } };
  const backlog = await execute(
    attach(backpressure.runId, "--json"),
    [discover, backpressure.stream, resumedBacklog.stream, fullRead(hydrated)],
    automationToken
  );
  assert.deepEqual(JSON.parse(backlog.stdout), hydrated);
  assert.deepEqual(diagnostics(backlog), [
    { type: "cloud_follow_gap", reason: "source_truncated" },
    { type: "cloud_follow_gap", reason: "retention", from: 2, through: 4 },
  ]);
  assert.deepEqual(
    await command(
      ["cloud", "logs", live.runId, "--follow", ...pairedFlags, "--json"],
      [discover, live.stream, fullRead(live.terminal)],
      automationToken
    ),
    { id: live.runId, pipelineId: "check", status: "completed", logs: live.terminal.logs }
  );

  for (const [errorName, exit] of [
    ["invalidCursor", 4],
    ["expiredCursor", 2],
    ["unauthenticated", 2],
    ["unsupportedMediaType", 2],
    ["missingRun", 2],
  ]) {
    const error = paired.errors[errorName];
    const cursor = "opaque+resume/with=encoding";
    const result = await execute(
      attach(live.runId, "--cursor", cursor, "--json"),
      [
        discover,
        response({
          ...error,
          path: `${live.path}?cursor=${encodeURIComponent(cursor)}`,
          method: "GET",
          accept: paired.stream.accept,
        }),
      ],
      automationToken,
      { exit }
    );
    assert.equal(result.stdout, "");
    assert.deepEqual(diagnostics(result), [
      {
        type: "cloud_follow_error",
        error: { ...error.body.error, status: error.status },
        recovery: { host: origin, workspaceId: paired.workspaceId, runId: live.runId, cursor },
      },
    ]);
  }

  const revoked = await followFixture("authorization-lost.ndjson");
  const lost = await execute(
    attach(revoked.runId, "--json"),
    [discover, revoked.stream],
    automationToken,
    { exit: 2 }
  );
  assert.equal(diagnostics(lost)[0].error.code, "authorization_lost");
  assert.equal(diagnostics(lost)[0].recovery.cursor, revoked.events.at(-1).cursor);

  const { runFollowing: _capability, ...legacy } = discover.responseBody;
  const unsupported = await execute(
    attach(live.runId, "--json"),
    [response(discover, legacy)],
    automationToken,
    { exit: 2 }
  );
  assert.equal(diagnostics(unsupported)[0].error.code, "unsupported_capability");
  const future = await execute(
    attach(live.runId, "--json"),
    [response(discover, { ...legacy, ...paired.discovery.unsupportedVersion })],
    automationToken,
    { exit: 2 }
  );
  assert.equal(diagnostics(future)[0].error.code, "unsupported_capability");
  const polled = await execute(
    attach(live.runId, "--poll", "--json"),
    [fullRead(live.terminal)],
    automationToken
  );
  assert.match(polled.stderr, /Polling retained Cloud status and logs/);
  assert.deepEqual(JSON.parse(polled.stdout), live.terminal);

  const waiting = await followFixture("deadline.ndjson");
  // A real SIGINT closes the observer. The second attachment observes the
  // same run finishing, and the server rejects any unexpected POST.
  const held = {
    ...waiting.stream,
    hold: true,
    raw:
      waiting.lines[0] +
      "\n" +
      resumedBacklog.lines[1]
        .replaceAll(backpressure.runId, waiting.runId)
        .replaceAll(resumedBacklog.events[1].cursor, waiting.events[0].cursor) +
      "\n",
  };
  const afterSignal = await execute(
    attach(waiting.runId, "--json"),
    [discover, held],
    automationToken,
    { exit: 7, interruptOn: "cloud_follow_gap" }
  );
  assert.equal(afterSignal.stdout, "");
  const interrupted = diagnostics(afterSignal).at(-1);
  assert.equal(interrupted.error.code, "observation_interrupted");
  assert.equal(interrupted.recovery.cursor, waiting.events[0].cursor);
  const finished = { ...live.terminal, id: waiting.runId };
  const finishedStream = {
    ...waiting.stream,
    path: `${waiting.path}?cursor=${interrupted.recovery.cursor}`,
    raw:
      [live.events[0], live.events.at(-1)]
        .map((event) =>
          JSON.stringify({
            ...event,
            runId: waiting.runId,
            cursor: interrupted.recovery.cursor,
            payload: { ...event.payload, run: finished },
          })
        )
        .join("\n") + "\n",
  };
  assert.deepEqual(
    await command(
      attach(waiting.runId, "--cursor", interrupted.recovery.cursor, "--json"),
      [discover, finishedStream, fullRead(finished)],
      automationToken
    ),
    finished
  );
  assert.deepEqual(
    await command(
      attach(waiting.runId, "--json"),
      [discover, waiting.stream, finishedStream, fullRead(finished)],
      automationToken
    ),
    finished
  );
} finally {
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  await rm(root, { recursive: true, force: true });
}
