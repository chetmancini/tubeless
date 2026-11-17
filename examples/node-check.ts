import { readNodeCheckPlan, runNodeCheck } from "tubeless/node/check";

/** Run with Node 24 after installing the candidate Tubeless release. No Cloud login. */
export async function checkRepository(root: string): Promise<void> {
  const plan = await readNodeCheckPlan(root);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const execution = await runNodeCheck(plan, {
      cwd: root,
      signal: controller.signal,
      log: { log: console.error, error: console.error, warn: console.error },
    });
    console.log(JSON.stringify(execution, null, 2));
    process.exitCode = execution.run.status === "completed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
