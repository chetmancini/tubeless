import { definePipelineCommand } from "tubeless/cli";
import { ValidatedPipeline } from "./validated-boundaries.js";

// The pipeline already owns its input schema. The CLI derives --source and
// includes --help, --dry-run, --step, --target and reporting automatically.
// Schema libraries with Standard JSON Schema support supply this metadata;
// validated-boundaries.ts uses a dependency-free schema to show the protocol.
export const ValidatedCommand = definePipelineCommand(ValidatedPipeline);

if (import.meta.main) {
  void ValidatedCommand.main();
}
