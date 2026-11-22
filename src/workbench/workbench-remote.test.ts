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
