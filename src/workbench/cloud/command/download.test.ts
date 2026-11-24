import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ReproductionManifest } from "../../../utilities/reproduction-manifest.js";
import { captureIo } from "../../workbench.test-support.js";
import { runCloud } from "./index.js";
import { baseRun, host, service, testDirectory } from "./index.test-support.js";

const bearer = "tlc_ci_download-fixture";
const env = { TUBELESS_TOKEN: bearer };
const target = ["--workspace", "workspace", "--host", host];
const artifact = ["download", baseRun.id, "sample.bin", "--output", "saved.bin", ...target];
const manifest = ["manifest", "fixture-run", "--output", "saved manifest.json", ...target];
const fixtureUrl = new URL(
  "../../../../fixtures/reproduction/node-check-failure-v1.json",
  import.meta.url
);

it.each([[[]], [[{ name: "summary.json", size: 3, contentType: "application/json" }]]])(
  "lists just the retained metadata from one run read, including an empty list",
  async (artifacts) => {
    const io = captureIo(await testDirectory());
    const dependencies = service({ runs: [{ ...baseRun, artifacts }] });
    expect(await runCloud(["artifacts", baseRun.id, "--json", ...target], io, dependencies)).toBe(
      0
    );
    expect(JSON.parse(io.output.join(""))).toEqual(artifacts);
    expect(dependencies.calls).toEqual([
      expect.objectContaining({ method: "GET", url: "/api/v1/workspaces/workspace/runs/run-1" }),
    ]);
  }
);

it("streams unmodified bytes to the chosen path and encodes the artifact name once", async () => {
  const io = captureIo(await testDirectory());
  const name = "é / %2f?#.bin";
  const chunks = [Uint8Array.of(0, 255, 10), new TextEncoder().encode(bearer)];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const bytes of chunks) controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "content-disposition": 'attachment; filename="../ignored.bin"' } }
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  expect(
    await runCloud([artifact[0], artifact[1], name, ...artifact.slice(3)], io, {
      env,
      fetch: fetcher,
    })
  ).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(String(url)).toBe(
    `${host}/api/v1/workspaces/workspace/runs/run-1/artifacts/%C3%A9%20%2F%20%252f%3F%23.bin`
  );
  expect(init).toMatchObject({ method: "GET", redirect: "error" });
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${bearer}`);
  expect(await readdir(io.cwd)).toEqual(["saved.bin"]);
  expect(await readFile(join(io.cwd, "saved.bin"))).toEqual(Buffer.concat(chunks));
  expect(io.output).toEqual([]);
  expect(io.errors.join("")).not.toContain(bearer);
});

it("saves the exact validated manifest for the requested run using a stored session", async () => {
  const io = captureIo(await testDirectory());
  const bytes = new Uint8Array(await readFile(fixtureUrl));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
  const store = {
    get: vi.fn(async () => ({ token: "stored-session", expiresAt: Date.now() + 60_000 })),
    set: vi.fn(),
    delete: vi.fn(),
  };
  expect(await runCloud(manifest, io, { env: {}, fetch: fetcher, store })).toBe(0);
  expect(store.get).toHaveBeenCalledWith(host);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(String(url)).toBe(`${host}/api/v1/workspaces/workspace/runs/fixture-run/reproduction`);
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer stored-session");
  expect(await readFile(join(io.cwd, "saved manifest.json"))).toEqual(Buffer.from(bytes));
  expect(await readdir(io.cwd)).toEqual(["saved manifest.json"]);
  expect(io.output).toEqual([]);
  expect(io.errors.join("")).toContain("tubeless cloud reproduce --execute '");
});

it.each([
  ["invalid JSON", "{", {}, "valid UTF-8 JSON"],
  ["wrong version", '{"version":2}', {}, "Unsupported reproduction manifest version"],
  ["body too large", " ".repeat(65537), {}, "exceeds 64 KiB"],
  ["declared body too large", "{}", { "content-length": "65537" }, "exceeds 64 KiB"],
] as const)(
  "discards a manifest with %s before installation",
  async (_name, body, headers, message) => {
    const io = captureIo(await testDirectory());
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers }));
    expect(await runCloud(manifest, io, { env, fetch: fetcher })).toBe(2);
    expect(io.errors.join("")).toContain(message);
    expect(await readdir(io.cwd)).toEqual([]);
  }
);

it.each([
  [
    "different run",
    (source: ReproductionManifest) => {
      source.run.id = "another-run";
    },
    "different run",
  ],
  [
    "wrong digest",
    (source: ReproductionManifest) => {
      source.nodeCheck.digest = "A".repeat(43);
    },
    "plan digest mismatch",
  ],
] as const)("rejects a valid-shaped manifest with %s", async (_label, modify, message) => {
  const io = captureIo(await testDirectory());
  const body = JSON.parse(await readFile(fixtureUrl, "utf8")) as ReproductionManifest;
  modify(body);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
  expect(await runCloud(manifest, io, { env, fetch: fetcher })).toBe(2);
  expect(io.errors.join("")).toContain(message);
  expect(await readdir(io.cwd)).toEqual([]);
});

it.each([
  [artifact, 403, "forbidden", "This credential requires the artifacts:read scope.", 2],
  [artifact, 404, "not_found", "This artifact is no longer retained.", 2],
  [manifest, 422, "unavailable", "Local reproduction supports portable Node/Bun checks only.", 6],
  [manifest, 404, "not_found", "This run is no longer retained.", 2],
  [["artifacts", baseRun.id, "--json", ...target], 404, "not_found", "Run not found.", 2],
] as const)(
  "reports Cloud denial or retention failure for %j (%s)",
  async (args, status, code, message, exit) => {
    const io = captureIo(await testDirectory());
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: { code, message } }, { status }));
    expect(await runCloud(args, io, { env, fetch: fetcher })).toBe(exit);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(io.errors.join("")).toContain(message);
    expect(io.output).toEqual([]);
    expect(await readdir(io.cwd)).toEqual([]);
  }
);

it.each([
  [302, { location: "https://other.example.test/artifact" }, "redirects are rejected"],
  [206, { "content-range": "bytes 0-2/10" }, "incomplete download"],
] as const)("discards an unexpected HTTP %s response", async (status, headers, message) => {
  const io = captureIo(await testDirectory());
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("abc", { status, headers }));
  expect(await runCloud(artifact, io, { env, fetch: fetcher })).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(io.errors.join("")).toContain(message);
  expect(await readdir(io.cwd)).toEqual([]);
});

it.each(["abort", "network"] as const)(
  "cleans up a partially written artifact after %s",
  async (failure) => {
    const controller = new AbortController();
    const io = { ...captureIo(await testDirectory()), signal: controller.signal };
    const stream = new TransformStream<Uint8Array>();
    const writer = stream.writable.getWriter();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream.readable));
    const pending = runCloud(artifact, io, { env, fetch: fetcher });
    const interrupt = {
      abort: () => controller.abort(),
      network: () => writer.abort(new Error("Connection reset")),
    };
    await writer.write(Uint8Array.of(1, 2, 3));
    await vi.waitFor(async () => {
      const [temporary] = await readdir(io.cwd);
      expect(temporary).toMatch(/\.tmp$/);
      expect(await readFile(join(io.cwd, temporary))).toEqual(Buffer.from([1, 2, 3]));
    });
    await interrupt[failure]();
    expect(await pending).toBe({ abort: 7, network: 2 }[failure]);
    expect(io.errors.join("")).toMatch(/interrupted/i);
    expect(await readdir(io.cwd)).toEqual([]);
  }
);

it("protects an existing symlink and preserves a file installed by a concurrent writer", async () => {
  const io = captureIo(await testDirectory());
  const destination = join(io.cwd, "saved.bin");
  const fetcher = vi.fn<typeof fetch>();
  await symlink("uncreated", destination);
  expect(await runCloud(artifact, io, { env, fetch: fetcher })).toBe(2);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(io.cwd)).toEqual(["saved.bin"]);

  const fresh = captureIo(await testDirectory());
  fetcher.mockImplementation(async () => {
    await writeFile(join(fresh.cwd, "saved.bin"), "other writer");
    return new Response("Cloud bytes");
  });
  expect(await runCloud(artifact, fresh, { env, fetch: fetcher })).toBe(2);
  expect(fresh.errors.join("")).toContain("Output already exists");
  expect(await readFile(join(fresh.cwd, "saved.bin"), "utf8")).toBe("other writer");
  expect(await readdir(fresh.cwd)).toEqual(["saved.bin"]);
});

it("reports a missing output directory before downloading", async () => {
  const io = captureIo(await testDirectory());
  const fetcher = vi.fn<typeof fetch>();
  expect(
    await runCloud([...artifact.slice(0, 4), "missing/saved.bin", ...target], io, {
      env,
      fetch: fetcher,
    })
  ).toBe(2);
  expect(fetcher).not.toHaveBeenCalled();
  expect(io.errors.join("")).toContain("Could not save Cloud download");
  expect(await readdir(io.cwd)).toEqual([]);
});
