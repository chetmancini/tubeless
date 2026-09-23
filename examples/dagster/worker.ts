import { openDagsterPipes } from "@dagster-io/dagster-pipes";
import { requireEnv } from "tubeless/node";
import { runDagsterJob } from "./hosted.js";

// Fail instead of silently using the SDK's no-op context outside Dagster.
requireEnv("DAGSTER_PIPES_CONTEXT", "Dagster worker");
requireEnv("DAGSTER_PIPES_MESSAGES", "Dagster worker");
const pipes = openDagsterPipes();
const controller = new AbortController();
const abort = () => controller.abort(new Error("Dagster subprocess was terminated"));
process.once("SIGTERM", abort);
process.once("SIGINT", abort);
try {
  await runDagsterJob(pipes, controller.signal);
} catch (error) {
  pipes.close(error instanceof Error ? error.message : "Tubeless execution failed");
  throw error; // Nonzero exit lets Dagster fail the asset and apply its retry policy.
} finally {
  process.removeListener("SIGTERM", abort);
  process.removeListener("SIGINT", abort);
  pipes.close(); // Flush and close once, including on failure.
}
