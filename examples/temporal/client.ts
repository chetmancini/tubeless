import { Client, Connection } from "@temporalio/client";
import type { normalizeWorkflow } from "./workflows.js";

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
try {
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
  const handle = await client.workflow.start<typeof normalizeWorkflow>("normalizeWorkflow", {
    taskQueue: "tubeless-example",
    workflowId: process.env.TEMPORAL_WORKFLOW_ID ?? "tubeless-normalize-demo",
    workflowIdReusePolicy: "REJECT_DUPLICATE",
    args: [{ lines: [" Alpha ", "", "Beta", "ALPHA"] }],
  });
  console.log(`Started Temporal Workflow ${handle.workflowId}`);
  console.log(await handle.result());
} finally {
  await connection.close();
}
