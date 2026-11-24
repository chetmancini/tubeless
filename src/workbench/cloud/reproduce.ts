import { reproduceCheck } from "../../check/reproduce.js";
import {
  parseReproductionManifest,
  REPRODUCTION_MANIFEST_MAX_BYTES,
} from "../../utilities/reproduction-manifest.js";
import { WORKBENCH_SPECS } from "../workbench-command-specs.js";
import { CliInputError, readCliFile } from "../workbench-json-input.js";
import {
  errorMessage,
  manageWorkbenchSignal,
  TUBELESS_WORKBENCH_EXIT_CODE as exit,
  writeUsageError,
  type WorkbenchCliIo,
} from "../workbench-shared.js";
import { renderWorkbenchUsage } from "../workbench-subcommand.js";

export async function runReproduce(
  paths: readonly string[],
  execute: boolean,
  io: WorkbenchCliIo
): Promise<number> {
  const usage = renderWorkbenchUsage(WORKBENCH_SPECS.cloud, "reproduce");
  if (paths.length !== 1) return writeUsageError(io, "Pass one reproduction manifest file.", usage);
  if (!execute)
    return writeUsageError(io, "Pass --execute to authorize running the pinned source.", usage);
  const interrupt = manageWorkbenchSignal(io);
  const { signal } = interrupt;
  try {
    const bytes = await readCliFile(
      paths[0],
      io.cwd,
      REPRODUCTION_MANIFEST_MAX_BYTES,
      "Reproduction manifest",
      signal
    ).catch((error: unknown) => {
      if (error instanceof CliInputError) throw error;
      throw new Error("Cannot read the reproduction manifest file.");
    });
    const manifest = await parseReproductionManifest(bytes);
    const result = await reproduceCheck(manifest, signal);
    io.stdout.write(JSON.stringify(result, null, 2) + "\n");
    const status = result.execution.run.status;
    if (status === "cancelled" || signal.aborted) return exit.cancellation;
    return status === "completed" ? exit.success : exit.execution;
  } catch (error) {
    if (signal.aborted) return exit.cancellation;
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return exit.validation;
  } finally {
    interrupt.cleanup();
  }
}
