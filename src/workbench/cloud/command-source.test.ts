import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { runCloud } from "./command.js";
import { captureIo } from "../workbench.test-support.js";
import { baseRun, pipeline, fixture, service } from "./command.test-support.js";

describe("Cloud source selection", () => {
  it.each([
    { file: false, json: false },
    { file: true, json: false },
    { file: false, json: true },
    { file: true, json: true },
  ])("sanitizes source progress only (file=$file, json=$json)", async ({ file, json }) => {
    const ref = "feature/\u009b31m\u202eorders";
    const source = { kind: "ref", ref };
    const root = await fixture();
    await writeFile(path.join(root, "source.json"), JSON.stringify(source));
    const dependencies = service({ admission: { ...baseRun, branch: ref } });
    const io = captureIo(root);
    expect(
      await runCloud(
        [
          "run",
          "--id",
          pipeline.id,
          "--workspace",
          "workspace",
          ...(file ? ["--source", "@source.json"] : ["--ref", ref]),
          "--detach",
          ...(json ? ["--json"] : []),
        ],
        io,
        dependencies
      )
    ).toBe(0);
    const progress = (json ? io.errors : io.output).join("");
    expect(progress).toContain('Requested source: {"kind":"ref","ref":"feature/ 31m orders"}');
    expect(progress).not.toMatch(/[\u009b\u202e]/);
    expect(dependencies.calls[0]!.body).toEqual({ pipelineId: pipeline.id, input: {}, source });
    if (json) expect(JSON.parse(io.output.join("")).branch).toBe(ref);
  });

  it("rejects malformed source before credential or HTTP access", async () => {
    const dependencies = service();
    const store = {
      get: () => {
        throw new Error("Unexpected keychain access");
      },
      set: async () => {},
      delete: async () => {},
    };
    const io = captureIo(await fixture());
    expect(
      await runCloud(["run", "--id", pipeline.id, "--source", "{"], io, {
        ...dependencies,
        env: {},
        store,
      })
    ).toBe(4);
    expect(dependencies.calls).toEqual([]);
  });
  it.each(["HEAD", "feature/orders", "tags/v1.2.3", "v1.2.3", "abc1234", "A".repeat(40)])(
    "submits --ref %s unchanged without discovery and preserves retry intent",
    async (ref) => {
      const dependencies = service({ lostAcknowledgement: true });
      const args = [
        "run",
        "--id",
        pipeline.id,
        "--workspace",
        "workspace",
        "--ref",
        ref,
        "--idempotency-key",
        "ref.same",
        "--detach",
        "--json",
      ];
      for (let attempt = 0; attempt < 2; attempt++) {
        const io = captureIo(await fixture());
        expect(await runCloud(args, io, dependencies)).toBe(0);
        expect(JSON.parse(io.output.join("")).id).toBe("run-1");
        expect(io.errors.join("")).toContain(
          `Requested source: ${JSON.stringify({ kind: "ref", ref })}`
        );
        expect(io.errors.join("")).toContain("Source commit: accepted-sha");
      }
      expect(dependencies.calls).toHaveLength(3);
      for (const call of dependencies.calls) {
        expect(call.method).toBe("POST");
        expect(call.body).toEqual({
          pipelineId: pipeline.id,
          input: {},
          source: { kind: "ref", ref },
        });
        expect(call.key).toBe("ref.same");
      }
    }
  );

  it.each(["missing-branch", "ambiguous-sha"])(
    "does not fall back to HEAD when Cloud rejects a ref: %s",
    async (ref) => {
      const dependencies = service({ admissionError: "not_found", admissionStatus: 404 });
      const io = captureIo(await fixture());
      expect(
        await runCloud(
          ["run", "--id", pipeline.id, "--workspace", "workspace", "--ref", ref, "--detach"],
          io,
          dependencies
        )
      ).toBe(2);
      expect(dependencies.calls).toHaveLength(1);
      expect(io.errors.join("")).not.toContain("Admission could not be confirmed");
    }
  );

  it.each([
    { kind: "main", commit: "A".repeat(40) },
    {
      kind: "pull_request",
      number: 19,
      headSha: "B".repeat(40),
      baseSha: "C".repeat(40),
      mergeSha: "D".repeat(40),
    },
  ])(
    "sends immutable $kind intent unchanged through retries and new invocations",
    async (source) => {
      const dependencies = service({ lostAcknowledgement: true });
      const root = await fixture();
      await writeFile(path.join(root, "source.json"), JSON.stringify(source));
      await writeFile(path.join(root, "input.json"), '{"n":42}');
      const args = [
        "run",
        "--id",
        pipeline.id,
        "--workspace",
        "workspace",
        "--source",
        "@source.json",
        "--input-file",
        "input.json",
        "--idempotency-key",
        "ci.fixed-intent",
        "--detach",
        "--json",
      ];
      for (let attempt = 0; attempt < 2; attempt++) {
        const io = captureIo(root);
        expect(await runCloud(args, io, dependencies)).toBe(0);
        expect(JSON.parse(io.output.join("")).id).toBe("run-1");
        expect(io.errors.join("")).toContain("Requested source:");
      }
      expect(dependencies.calls).toHaveLength(3);
      const normalized =
        source.kind === "main"
          ? { kind: "main", commit: "a".repeat(40) }
          : {
              kind: "pull_request",
              number: 19,
              headSha: "b".repeat(40),
              baseSha: "c".repeat(40),
              mergeSha: "d".repeat(40),
            };
      for (const call of dependencies.calls) {
        expect(call.method).toBe("POST");
        expect(call.key).toBe("ci.fixed-intent");
        expect(call.body).toEqual({
          pipelineId: pipeline.id,
          input: { n: 42 },
          source: normalized,
        });
      }
    }
  );

  it("reads a source selector from stdin without changing the default input", async () => {
    const source = { kind: "main", commit: "a".repeat(40) };
    const dependencies = { ...service(), readStdin: async () => JSON.stringify(source) };
    expect(
      await runCloud(
        ["run", "--id", pipeline.id, "--workspace", "workspace", "--source", "-", "--detach"],
        captureIo(await fixture()),
        dependencies
      )
    ).toBe(0);
    expect(dependencies.calls[0]!.body).toEqual({ pipelineId: pipeline.id, input: {}, source });
  });
});
