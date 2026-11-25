import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { executeAction, type ActionHost } from "./action.js";
import { createGitHubCommentStore } from "./github.js";
import {
  commandEnvironment,
  publishStickyComment,
  readRequest,
  resolveTubelessInvocation,
  stickyMarker,
  type CommandResult,
} from "./report.js";

export function formatOutputs(outputs: {
  readonly plan: string;
  readonly mermaid: string;
}): string {
  return `${outputField("plan", outputs.plan)}${outputField("mermaid", outputs.mermaid)}`;
}

function outputField(name: string, value: string): string {
  const delimiter = `tubeless_${randomBytes(16).toString("hex")}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

export function runTubeless(
  invocation: { command: string; args: readonly string[] },
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): CommandResult {
  const result = spawnSync(invocation.command, [...invocation.args, ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    const detail = result.error.message;
    return {
      stdout,
      stderr: stderr === "" ? detail : `${stderr}\n${detail}`,
      exitCode: 1,
    };
  }
  return { stdout, stderr, exitCode: result.status ?? 1 };
}

function createHost(cwd: string, env: NodeJS.ProcessEnv): ActionHost {
  const request = readRequest(env);
  const invocation = resolveTubelessInvocation(cwd, existsSync);
  const childEnv = commandEnvironment(env);
  return {
    run(args) {
      return runTubeless(invocation, args, cwd, childEnv);
    },
    writeSummary(markdown) {
      const path = env.GITHUB_STEP_SUMMARY;
      if (path) appendFileSync(path, `${markdown}\n`);
    },
    writeOutputs(outputs) {
      const path = env.GITHUB_OUTPUT;
      if (path) appendFileSync(path, formatOutputs(outputs));
    },
    async comment(body) {
      const token = env.GITHUB_TOKEN ?? "";
      if (token === "" || request.pullRequest === undefined) {
        throw new Error(
          "A pull request comment needs GITHUB_TOKEN. Grant pull-requests: write on the workflow."
        );
      }
      const store = createGitHubCommentStore({
        fetch: globalThis.fetch,
        apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
        repository: env.GITHUB_REPOSITORY ?? "",
        token,
        pullRequest: request.pullRequest,
      });
      const outcome = await publishStickyComment(store, body, stickyMarker(request.pipeline));
      const verb = outcome === "updated" ? "Updated" : "Posted";
      process.stdout.write(`${verb} the Tubeless pull request comment.\n`);
    },
    log(line) {
      process.stdout.write(`${line}\n`);
    },
  };
}

export async function runAction(env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  return executeAction(readRequest(env), createHost(cwd, env));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runAction(process.env, process.cwd())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Tubeless action failed.";
      const secret = process.env.INPUT_CLOUD_TOKEN ?? "";
      const redacted = secret === "" ? message : message.split(secret).join("[redacted]");
      process.stderr.write(`${redacted}\n`);
      process.exitCode = 1;
    });
}
