import {
  compilePipelineDocument,
  defineProject,
  type CompiledPipelineDocument,
  type PipelineDocumentMetadata,
  type ProjectRegistry,
} from "tubeless/project";
import { definePipelineCommand } from "tubeless/cli";

const document: unknown = JSON.parse(`{
  "version": 1,
  "metadata": { "name": "Document jobs", "authors": ["Maintainer"], "date": "2026-09-21" },
  "pipelines": {
    "echo": { "steps": [{ "id": "echo", "run": "echo" }], "finalize": { "run": "result" } },
    "private": { "steps": [{ "id": "echo", "run": "echo" }], "finalize": { "run": "result" } }
  }
}`);
const registry: ProjectRegistry = {
  steps: {
    echo: (_inputs, context) => ("message" in context.options ? context.options.message : ""),
  },
  finalizers: { result: ({ echo }) => echo },
};
const compiled: CompiledPipelineDocument = compilePipelineDocument(document, registry);
const metadata: PipelineDocumentMetadata | undefined = compiled.metadata;
const pipeline = compiled.get("echo");
const command = definePipelineCommand(pipeline, {
  params: { message: { type: "string" } },
  mapOptions: ({ message }) => ({ message }),
  reporter: false,
});
const project = defineProject("packed-document", [pipeline], {
  name: metadata?.name,
  commands: [command],
});
if (project.get("echo") !== pipeline || compiled.pipelines[0] !== pipeline) {
  throw new Error("Compilation and registration must preserve pipeline instances");
}
if (project.pipelineIds.length !== 1 || project.name !== "Document jobs") {
  throw new Error("Registration must expose only selected pipelines and explicit metadata");
}
if (!Object.isFrozen(compiled.pipelines) || !Object.isFrozen(metadata?.authors)) {
  throw new Error("Compiled document snapshots must be immutable");
}
if ((await command.run(["--message", "hello"])) !== "hello") {
  throw new Error("Compiled pipeline command failed");
}

if (false) {
  // @ts-expect-error Unknown documents do not infer literal pipeline ids.
  const id: "echo" = pipeline.id;
  // @ts-expect-error A dynamic pipeline does not promise a domain result type.
  const value: Promise<string> = pipeline.runOrThrow({});
  // @ts-expect-error Compilation has no generic trust-this-type escape hatch.
  compilePipelineDocument<string>(document, registry);
  // @ts-expect-error Compilation is no longer a defineProject overload.
  defineProject("removed", document, registry);
  // @ts-expect-error The four-argument document overload is also removed.
  defineProject("removed", document, registry, { name: "Old API" });
  // @ts-expect-error Compiled metadata is readonly.
  metadata!.name = "Changed";
  // @ts-expect-error Compiled collections are readonly.
  compiled.pipelines.push(pipeline);
  void id;
  void value;
}
