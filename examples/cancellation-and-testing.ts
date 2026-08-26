import { createSteps, definePipeline } from "tubeless";
import { createPipelineTestRuntime } from "tubeless/testing";

interface PollOptions {
  attempts: number;
}

const step = createSteps<PollOptions>();

const poll = step("poll", {
  description: "Poll cooperatively with an injected, cancellation-aware sleep",
  run: async (_inputs, context) => {
    for (let attempt = 1; attempt <= context.options.attempts; attempt += 1) {
      await context.sleep(100, context.signal);
      context.reportProgress({ completed: attempt, total: context.options.attempts });
    }
    return context.options.attempts;
  },
});

export const PollPipeline = definePipeline({
  id: "poll",
  steps: [poll],
  finalize: (outputs) => outputs.poll ?? 0,
});

export async function runWithTestRuntime() {
  const test = createPipelineTestRuntime({ cwd: "/workspace" });
  const value: number = await test.runOrThrow(PollPipeline, { attempts: 3 });

  return {
    elapsedMs: test.clock.now(),
    latestProgress: test.latestProgress.get("poll"),
    logs: test.logs,
    statuses: test.statuses,
    value,
  };
}

export async function runCancelledTest() {
  const test = createPipelineTestRuntime();
  test.abort("cancel the test run");

  return test.run(PollPipeline, { attempts: 3 });
}
