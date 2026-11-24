import { expect, it, vi } from "vitest";
import { captureIo } from "../../workbench.test-support.js";
import { runCloud } from "./index.js";
import { fixture, host, service } from "./index.test-support.js";

const args = ["cancel", "run-1", "--workspace", "workspace", "--host", host];
const env = { TUBELESS_TOKEN: "tlc_ci_v1.test-only" };

it.each([
  ["running", false, "Cancellation request accepted"],
  ["waiting", false, "Cancellation request accepted"],
  ["cancelled", false, "Cancellation request accepted"],
  ["completed", false, "Cancellation request accepted"],
  ["failed", true, "Run had already finished"],
  ["cancelled", true, "Run had already finished"],
] as const)(
  "reports %s with alreadyFinished=%s as a successful receipt",
  async (status, alreadyFinished, message) => {
    const result = { runId: "run-1", status, alreadyFinished };
    const dependencies = service({ cancellation: result });
    const io = captureIo(await fixture());
    expect(await runCloud(args, io, dependencies)).toBe(0);
    expect(io.output.join("")).toContain(`${message} for run-1. Current status: ${status}.`);
    expect(await runCloud([...args, "--json"], io, dependencies)).toBe(0);
    expect(JSON.parse(io.output.at(-1)!)).toEqual(result);
    expect(dependencies.calls).toEqual(
      Array.from({ length: 2 }, () => ({
        method: "POST",
        url: "/api/v1/workspaces/workspace/runs/run-1/cancel",
        body: {},
        key: undefined,
      }))
    );
  }
);

it.each([
  [401, "unauthenticated", 2],
  [403, "forbidden", 2],
  [404, "not_found", 2],
  [400, "invalid_request", 4],
  [429, "quota_exceeded", 6],
  [429, "rate_limited", 6],
] as const)("uses Cloud error mapping for HTTP %s %s", async (status, code, exit) => {
  for (const command of ["inspect", "cancel"]) {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code, message: `Cloud detail ${env.TUBELESS_TOKEN}` } }, { status })
    );
    const io = captureIo(await fixture());
    expect(await runCloud([command, ...args.slice(1), "--json"], io, { env, fetch: fetcher })).toBe(
      exit
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(io.output).toEqual([]);
    expect(io.errors.join("")).toContain("Cloud detail");
    expect(io.errors.join("")).not.toContain(env.TUBELESS_TOKEN);
    expect(io.errors.join("")).not.toContain("could not be confirmed");
  }
});

it.each([
  [
    "network failure",
    () => {
      throw new Error(env.TUBELESS_TOKEN);
    },
  ],
  [
    "wrong run",
    () => Response.json({ runId: "other", status: "cancelled", alreadyFinished: false }),
  ],
  ["missing outcome flag", () => Response.json({ runId: "run-1", status: "cancelled" })],
  [
    "invalid status",
    () => Response.json({ runId: "run-1", status: "sent", alreadyFinished: false }),
  ],
  [
    "server failure",
    () => Response.json({ error: { code: "internal_error", message: "Error" } }, { status: 500 }),
  ],
] as const)("reports uncertain cancellation after %s with no retry", async (_name, respond) => {
  const fetcher = vi.fn<typeof fetch>(async () => respond());
  const io = captureIo(await fixture());
  expect(await runCloud([...args, "--json"], io, { env, fetch: fetcher })).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(io.output).toEqual([]);
  expect(io.errors.join("")).toContain("Cancellation could not be confirmed");
  expect(io.errors.join("")).toContain("cloud inspect");
  expect(io.errors.join("")).not.toContain(env.TUBELESS_TOKEN);
});
