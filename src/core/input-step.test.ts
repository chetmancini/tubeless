import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "./pipeline.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("input steps", () => {
  it("keeps execution pending until the adapter replies, then validates and feeds dependents", async () => {
    const { step, waitForInput } = createSteps<{ question: string }>();
    const started = deferred<void>();
    const reply = deferred<string>();
    const complete = vi.fn();
    const question = step("question", { run: (_inputs, context) => context.options.question });
    const number: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) =>
          typeof value === "string" && /^\d+$/.test(value)
            ? { value: Number(value) }
            : { issues: [{ message: "Expected digits" }] },
      },
    };
    const answer = waitForInput("answer", {
      dependsOn: [question],
      outputSchema: number,
      read: ({ question }, context) => {
        expectTypeOf(question).toEqualTypeOf<string>();
        expect(context.options.question).toBe("Pick a number");
        started.resolve();
        return reply.promise;
      },
    });
    const doubled = step("doubled", {
      dependsOn: [answer],
      run: ({ answer }) => {
        expectTypeOf(answer).toEqualTypeOf<number>();
        return answer * 2;
      },
    });
    const pipeline = definePipeline({ steps: [question, answer, doubled], id: "input" });
    const progress: string[] = [];
    const running = pipeline.runOrThrow({ question: "Pick a number" }, undefined, {
      hooks: {
        onStepProgress: ({ progress: event }) => progress.push(event.message ?? ""),
        onPipelineComplete: complete,
      },
    });
    await started.promise;
    expect(complete).not.toHaveBeenCalled();
    expect(progress).toContain("Waiting for input");
    reply.resolve("21");
    expect(await running).toBe(42);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("rejects invalid input before running dependent work", async () => {
    const { step, waitForInput } = createSteps();
    const dependent = vi.fn();
    const answer = waitForInput("answer", {
      outputSchema: {
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (_value: unknown) => ({ issues: [{ message: "Invalid response" }] }),
        },
      },
      read: () => "bad",
    });
    const work = step("work", { dependsOn: [answer], run: dependent });
    const result = await definePipeline({ id: "invalid-input", steps: [answer, work] }).run();
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.message).toContain("Invalid response");
    expect(dependent).not.toHaveBeenCalled();
  });

  it("cancels an uncooperative input source and ignores its late rejection", async () => {
    const started = deferred<void>();
    const reply = deferred<string>();
    const controller = new AbortController();
    const { waitForInput } = createSteps();
    const input = waitForInput("input", {
      read: (_inputs, context) => {
        expect(context.signal).toBe(controller.signal);
        started.resolve();
        return reply.promise;
      },
    });
    const running = definePipeline({ id: "cancel-input", steps: [input] }).run(
      undefined,
      undefined,
      { signal: controller.signal }
    );
    await started.promise;
    controller.abort();
    expect((await running).status).toBe("cancelled");
    reply.reject(new Error("late adapter error"));
    await Promise.resolve();
  });

  it("skips input in dry runs and supports an explicit preview", async () => {
    const read = vi.fn(() => "live");
    const { waitForInput } = createSteps();
    const skipped = waitForInput("input", { read });
    const preview = waitForInput("preview", { read, dryRun: () => "preview" });
    const result = await definePipeline({ id: "preview-input", steps: [skipped, preview] }).run(
      undefined,
      { dryRun: true }
    );
    expect(result.value).toBe("preview");
    expect(result.steps[0]?.status).toBe("skipped");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects caching an input source", () => {
    const { waitForInput } = createSteps();
    const config = { read: () => "input", cache: true };
    expect(() => {
      // @ts-expect-error A cached input would bypass the next user interaction.
      waitForInput("input", config);
    }).toThrow("cannot be cached");
  });

  it("rejects policy skips from configuration variables for plain and schema-backed input", () => {
    const { waitForInput } = createSteps();
    const config = { read: () => "input", skip: () => "declined" };
    const outputSchema: StandardSchemaV1<string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: String(value) }),
      },
    };
    const validatedConfig = { ...config, outputSchema };
    expect(() => {
      // @ts-expect-error A hidden policy skip would publish undefined as string.
      waitForInput("plain", config);
    }).toThrow("cannot use policy skips");
    expect(() => {
      // @ts-expect-error Schema-backed input must obey the same skip restriction.
      waitForInput("validated", validatedConfig);
    }).toThrow("cannot use policy skips");
  });
});
