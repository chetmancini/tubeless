import type { NodeCheckFileRequest } from "tubeless/check-plan";
import { readNodeCheckPlan, runNodeCheck, runNodeCheckFiles } from "tubeless/node/check";

/** Run with Node 24 after installing the candidate Tubeless release. No Cloud login. */
export async function checkRepository(root: string, files?: NodeCheckFileRequest): Promise<void> {
  const plan = await readNodeCheckPlan(root);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const context = {
      cwd: root,
      signal: controller.signal,
      log: { log: console.error, error: console.error, warn: console.error },
    };
    const execution = files
      ? await runNodeCheckFiles(plan, context, files)
      : await runNodeCheck(plan, context);
    console.log(JSON.stringify(execution, null, 2));
    process.exitCode = execution.run.status === "completed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
