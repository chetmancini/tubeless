import { createSteps, definePipeline } from "tubeless";

interface WelcomeOptions {
  name?: string;
}

const { step } = createSteps<WelcomeOptions>();
const greet = step("greet", {
  run: (_inputs, context) => `Hello, ${context.options.name ?? "world"}!`,
});
const GreetingPipeline = definePipeline({ id: "greeting", steps: [greet], finalize: greet });

const { fromPipeline } = createSteps<WelcomeOptions>();
const greeting = fromPipeline("greeting", {
  pipeline: GreetingPipeline,
  // Matching parent inputs are inherited; mapOptions is only needed to change them.
});

export const WelcomePipeline = definePipeline({
  id: "welcome",
  steps: [greeting],
  finalize: greeting,
});

export async function runInheritedInputsExample(): Promise<string> {
  // All input fields are optional, so omitted input defaults to a fresh {}.
  return WelcomePipeline.runOrThrow();
}
