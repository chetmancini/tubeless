import { expect, it, vi } from "vitest";
import { runRemote } from "./workbench-remote.js";

const HOST = "https://studio.example";
const env = { CF_ACCESS_CLIENT_ID: "service-id", CF_ACCESS_CLIENT_SECRET: "service-secret" };

function capture() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    io: {
      cwd: process.cwd(),
      stdout: {
        write: (line: string) => {
          output.push(line);
        },
      },
      stderr: {
        write: (line: string) => {
          errors.push(line);
        },
      },
    },
  };
}

it("retries an uncertain submission with the original normalized request and key", async () => {
  const { io, output, errors } = capture();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new Error("lost reply"))
    .mockResolvedValueOnce(Response.json({ executionId: "accepted" }, { status: 202 }));
  const args = ["run", "greeting", "--host", HOST, "--json", "--detach", "--input-file", "-"];
  expect(await runRemote(args, io, { fetch, env, readStdin: async () => '{"name":"Ada"}' })).toBe(
    0
  );
  const [first, second] = fetch.mock.calls;
  expect(first[0]).toBe(`${HOST}/api/executions/v1`);
  expect(first[1]?.body).toBe(second[1]?.body);
  expect(JSON.parse(String(first[1]?.body))).toEqual({
    commandId: "greeting",
    values: { name: "Ada" },
    idempotencyKey: expect.any(String),
  });
  const headers = new Headers(first[1]?.headers);
  expect(headers.get("cf-access-client-id")).toBe(env.CF_ACCESS_CLIENT_ID);
  expect(headers.get("cf-access-client-secret")).toBe(env.CF_ACCESS_CLIENT_SECRET);
  expect(output.join("")).toBe('{"executionId":"accepted"}\n');
  expect(errors).toEqual([]);
});

it("reports a cancellation request separately from terminal cancellation", async () => {
  const { io, output } = capture();
  const status = {
    executionId: "admitted",
    commandId: "greeting",
    state: "running",
    cancellationRequested: true,
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(status, { status: 202 }))
    .mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(Response.json({ ...status, state: "cancelled" }));
  const common = ["admitted", "--host", HOST, "--json"];
  expect(await runRemote(["cancel", ...common], io, { fetch, env })).toBe(0);
  expect(JSON.parse(output[0])).toEqual(status);
  expect(fetch.mock.calls[0][0]).toBe(`${HOST}/api/executions/v1/admitted/cancel`);
  expect(fetch.mock.calls[0][1]?.method).toBe("POST");
  expect(
    await runRemote(["status", ...common, "--follow"], io, { fetch, env, sleep: async () => {} })
  ).toBe(7);
  expect(JSON.parse(output[1])).toMatchObject({ state: "cancelled" });
});

it("refuses redirects without exposing the Access credential", async () => {
  const { io, output, errors } = capture();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://other.example" } })
    );
  expect(await runRemote(["status", "admitted", "--host", HOST], io, { fetch, env })).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
  expect(output).toEqual([]);
  expect(errors.join("")).toContain("Check the host and Access Service Auth policy");
  expect(errors.join("")).not.toContain(env.CF_ACCESS_CLIENT_SECRET);
});

const active = {
  executionId: "admitted",
  commandId: "greeting",
  state: "running",
  cancellationRequested: false,
};
const discovery = { ...active, runFollowing: { version: 1, transport: "ndjson" } };
const frame = (cursor: number, type: string, payload: object) =>
  JSON.stringify({ executionId: active.executionId, version: 1, cursor, type, payload }) + "\n";
const streamHeaders = { "content-type": "application/x-ndjson" };

it("rejects an invalid frame as a protocol error without reconnecting", async () => {
  const { io, errors } = capture();
  const terminal = { ...active, state: "completed", executionId: "another-execution" };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(discovery))
    .mockResolvedValueOnce(
      new Response(frame(0, "snapshot", active) + frame(0, "terminal", terminal), {
        headers: streamHeaders,
      })
    );
  expect(
    await runRemote(["status", "admitted", "--follow", "--host", HOST], io, { env, fetch })
  ).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(errors.join("")).toContain("invalid execution event stream");
});

it("resumes after a partial record, deduplicates output and drains the terminal status", async () => {
  const { io, output, errors } = capture();
  const log = frame(7, "log", {
    runId: "child",
    parentRunId: "root",
    pipelineId: "transform",
    stepId: "read",
    attemptId: "attempt-1",
    level: "log",
    message: "Read café",
  });
  const progress = frame(9, "progress", {
    runId: "child",
    parentRunId: "root",
    pipelineId: "transform",
    completed: 1,
    total: 1,
    message: "done",
  });
  const first = new TextEncoder().encode(
    frame(0, "snapshot", active) + log + progress.slice(0, -1)
  );
  const split = first.indexOf(0xc3) + 1;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(discovery))
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first.subarray(0, split));
            controller.enqueue(first.subarray(split));
            controller.close();
          },
        }),
        { headers: streamHeaders }
      )
    )
    .mockResolvedValueOnce(
      new Response(
        frame(7, "snapshot", active) +
          log +
          progress +
          frame(9, "gap", { reason: "history_unavailable" }) +
          frame(9, "terminal", { ...active, state: "outcome_unknown" }),
        { headers: streamHeaders }
      )
    );
  expect(
    await runRemote(["status", "admitted", "--follow", "--host", HOST], io, {
      fetch,
      env,
      sleep: async () => {},
    })
  ).toBe(6);
  expect(fetch.mock.calls.map(([url]) => String(url).split("/api/executions/v1")[1])).toEqual([
    "/admitted",
    "/admitted/events?cursor=0",
    "/admitted/events?cursor=7",
  ]);
  expect(output.filter((line) => line.includes("Read café"))).toEqual([
    "log [transform/read run=child parent=root attempt=attempt-1]: Read café\n",
  ]);
  expect(output.at(-2)).toBe("progress [transform run=child parent=root]: 1/1 done\n");
  expect(output.at(-1)).toContain("outcome_unknown");
  expect(errors.join("")).toContain("Some execution history is unavailable.");
});

it.each([401, 403])(
  "surfaces HTTP %s while following instead of switching to polling",
  async (status) => {
    const { io, errors } = capture();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discovery))
      .mockResolvedValueOnce(new Response(null, { status }));
    expect(
      await runRemote(["status", "admitted", "--follow", "--host", HOST], io, { env, fetch })
    ).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(errors.join("")).toContain(`HTTP ${status}`);
  }
);
