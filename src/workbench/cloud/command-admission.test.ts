import { describe, expect, it } from "vitest";
import { runCloud } from "./command.js";
import { captureIo } from "../workbench.test-support.js";
import { pipeline, fixture, service } from "./command.test-support.js";

describe("Cloud admission recovery", () => {
  it("passes stdin JSON objects and reuses the key after a lost acknowledgement", async () => {
    const root = await fixture();
    const dependencies = {
      ...service({ lostAcknowledgement: true }),
      readStdin: async () => '{"hello":"world"}',
    };
    expect(
      await runCloud(
        ["run", pipeline.name, "--input-file", "-", "--detach"],
        captureIo(root),
        dependencies
      )
    ).toBe(0);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.key).toBe(admissions[1]!.key);
    expect(admissions[0]!.body).toEqual({ pipelineId: pipeline.id, input: { hello: "world" } });
  });

  it("does not retry or report uncertain admission when normalized JSON exceeds the input budget", async () => {
    const input = `{"values":[${Array(4000).fill("1e20").join(",")}]}`;
    expect(Buffer.byteLength(input)).toBeLessThan(65536);
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(input)))).toBeGreaterThan(65536);
    const dependencies = { ...service(), readStdin: async () => input };
    const io = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.name, "--input-file", "-"], io, dependencies)).toBe(4);
    expect(dependencies.calls.every((call) => call.method === "GET")).toBe(true);
    expect(io.errors.join("")).not.toContain("idempotency key");
    expect(io.errors.join("")).not.toContain("Admission could not be confirmed");
  });
  it("reports a recoverable key after a server error following the POST", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "internal_error", admissionStatus: 500 });
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name, "--json"], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(
      `Workspace: workspace; idempotency key: ${admissions[0]!.key}`
    );
    expect(io.output.join("")).toBe("");
  });
  it("reports a recoverable key for an unusable successful admission response", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      return init?.method === "POST"
        ? Response.json({ admitted: true }, { status: 202 })
        : response;
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(`idempotency key: ${admissions[0]!.key}`);
  });
  it("reports the same key when interruption loses a pending POST acknowledgement", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const dependencies = service();
    const original = dependencies.fetch;
    let markPosted: () => void = () => {};
    const posted = new Promise<void>((resolve) => {
      markPosted = resolve;
    });
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method !== "POST") return response;
      markPosted();
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const io = { ...captureIo(root), signal: controller.signal };
    const result = runCloud(["run", pipeline.name, "--json"], io, dependencies);
    await posted;
    controller.abort();
    expect(await result).toBe(7);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(io.errors.join("")).toContain(
      `Workspace: workspace; idempotency key: ${admissions[0]!.key}`
    );
    expect(io.output.join("")).toBe("");
  });
  it("keeps one recoverable key through the bounded failed transport retry", async () => {
    const root = await fixture();
    const dependencies = service();
    const original = dependencies.fetch;
    dependencies.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await original(url, init);
      if (init?.method === "POST") throw new Error("lost response");
      return response;
    }) as typeof fetch;
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(2);
    const admissions = dependencies.calls.filter((call) => call.method === "POST");
    expect(admissions).toHaveLength(2);
    expect(admissions[0]!.key).toBe(admissions[1]!.key);
    expect(io.errors.join("").match(/Admission could not be confirmed/g)).toHaveLength(1);
    expect(io.errors.join("")).toContain(`idempotency key: ${admissions[0]!.key}`);
  });
  it("definite 4xx rejection does not suggest an uncertain admission", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "invalid_request", admissionStatus: 400 });
    const io = captureIo(root);
    expect(await runCloud(["run", pipeline.name], io, dependencies)).toBe(4);
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(io.errors.join("")).not.toContain("idempotency key");
  });
  it("rate-limited admission exits execution failure without retry", async () => {
    const root = await fixture();
    const dependencies = service({ admissionError: "rate_limited" });
    expect(await runCloud(["run", pipeline.name], captureIo(root), dependencies)).toBe(6);
    expect(dependencies.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});
