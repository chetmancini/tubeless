import { reproduceCheck } from "../../check/reproduce.js";
import {
  parseReproductionManifest,
  REPRODUCTION_MANIFEST_MAX_BYTES,
} from "../../utilities/reproduction-manifest.js";
import { CliInputError, readCliFile } from "../workbench-json-input.js";
import {
  errorMessage,
  manageWorkbenchSignal,
  TUBELESS_WORKBENCH_EXIT_CODE as exit,
  type WorkbenchCliIo,
} from "../workbench-shared.js";

export async function runReproduce(path: string, io: WorkbenchCliIo): Promise<number> {
  const interrupt = manageWorkbenchSignal(io);
  const { signal } = interrupt;
  try {
    const bytes = await readCliFile(
      path,
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
