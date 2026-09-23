import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { runPipeline } from "./activities.js";

// Compile this directory first, then run with Node.js (not Bun).
const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
try {
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: "tubeless-example",
    workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
    activities: { runPipeline },
  });
  // The SDK handles SIGINT/SIGTERM and drains the Worker before run resolves.
  await worker.run();
} finally {
  await connection.close();
}
