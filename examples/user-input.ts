import { createSteps, definePipeline } from "tubeless";

/** A terminal, web form, or application can supply the same input adapter. */
export function createReviewPipeline(
  readInput: (question: string, signal?: AbortSignal) => Promise<string>
) {
  const { step, waitForInput } = createSteps<{ draft: string }>();
  const draft = step("draft", { run: (_inputs, context) => context.options.draft });
  const feedback = waitForInput("feedback", {
    dependsOn: [draft],
    description: "Wait for the user's review before continuing.",
    read: ({ draft }, context) => readInput(`Review this draft:\n${draft}`, context.signal),
    dryRun: () => "Preview feedback",
  });
  const reviewed = step("reviewed", {
    dependsOn: [draft, feedback],
    run: ({ draft, feedback }) => ({ draft, feedback }),
  });
  return definePipeline({
    id: "user-review",
    steps: [draft, feedback, reviewed],
    finalize: reviewed,
  });
}
