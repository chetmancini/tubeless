import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pairedRoot = new URL("../../fixtures/cloud-run-follow/v1/", import.meta.url);
const paired = JSON.parse(await readFile(new URL("exchanges.json", pairedRoot), "utf8"));
const pairedRuns = `/api/v1/workspaces/${paired.workspaceId}/runs`;

const retainedRun = {
  actor: "fixture-user",
  artifacts: [],
  branch: "main",
  commit: "fixture-commit",
  input: {},
  logs: [{ time: 1000, level: "info", message: "retained log" }],
  steps: [],
  trigger: "manual",
};

function response(exchange, body = exchange.body) {
  return { ...exchange, responseBody: body };
}
function diagnostics({ stderr }) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}
const ndjson = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

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
    terminal: last.type === "terminal" ? { ...retainedRun, ...last.payload.run } : undefined,
  };
}

export async function verifyPackedCloudFollow({ execute, command, origin, automationToken }) {
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
  const { result: _result, ...admitted } = live.terminal;
  const submit = {
    method: "POST",
    path: pairedRuns,
    requestBody: { pipelineId: "check", input: {} },
    responseBody: { ...admitted, ...live.events[0].payload.run },
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
  const [loss] = diagnostics(lost);
  assert.equal(loss.error.code, "authorization_lost");
  assert.equal(loss.recovery.cursor, revoked.events.at(-1).cursor);

  const { runFollowing: _capability, ...legacy } = discover.responseBody;
  for (const capabilities of [legacy, { ...legacy, ...paired.discovery.unsupportedVersion }]) {
    const unsupported = await execute(
      attach(live.runId, "--json"),
      [response(discover, capabilities)],
      automationToken,
      { exit: 2 }
    );
    assert.equal(diagnostics(unsupported)[0].error.code, "unsupported_capability");
  }
  const polled = await execute(
    attach(live.runId, "--poll", "--json"),
    [fullRead(live.terminal)],
    automationToken
  );
  assert.match(polled.stderr, /Polling retained Cloud status and logs/);
  assert.deepEqual(JSON.parse(polled.stdout), live.terminal);

  const waiting = await followFixture("deadline.ndjson");
  const [snapshot] = waiting.events;
  // A real SIGINT closes the observer. The second attachment observes the
  // same run finishing, and the server rejects any unexpected POST.
  const held = {
    ...waiting.stream,
    hold: true,
    raw: ndjson(snapshot, { ...snapshot, type: "gap", payload: { reason: "source_truncated" } }),
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
  assert.equal(interrupted.recovery.cursor, snapshot.cursor);
  const finished = { ...live.terminal, id: waiting.runId };
  const finishedStream = {
    ...waiting.stream,
    path: `${waiting.path}?cursor=${interrupted.recovery.cursor}`,
    raw: ndjson(
      { ...snapshot, payload: { run: finished } },
      { ...snapshot, type: "terminal", payload: { run: finished, outcome: "completed" } }
    ),
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
}
