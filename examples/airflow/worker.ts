import { writeJson, requireEnv } from "tubeless/node";
import { runAirflowJob } from "./hosted.js";

// Executed by the Airflow Python task with Bun. No shell interpolation or
// command-line JSON; stdout remains available for structured task logs.
const controller = new AbortController();
const abort = () => controller.abort(new Error("Airflow worker was terminated"));
process.once("SIGTERM", abort);
process.once("SIGINT", abort);
try {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const job: unknown = JSON.parse(input);
  const result = await runAirflowJob(job, controller.signal, {
    export: (event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });
  // Only a successful pipeline produces the result Python will return to XCom.
  await writeJson(requireEnv("TUBELESS_RESULT_PATH", "Airflow worker"), result);
} finally {
  process.removeListener("SIGTERM", abort);
  process.removeListener("SIGINT", abort);
}
