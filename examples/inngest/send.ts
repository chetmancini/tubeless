import { inngest } from "./client.js";
import type { InngestJob } from "./functions.js";

const data = {
  lines: [" Alpha ", "", "Beta", "ALPHA"],
  dryRun: false,
} satisfies InngestJob;

const { ids } = await inngest.send({ name: "tubeless/normalize.requested", data });
console.log("Accepted event IDs:", ids);
// Acceptance is not pipeline completion. Inspect the run in the Inngest UI.
