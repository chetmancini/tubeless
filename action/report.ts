import { join } from "node:path";

export const MODES = ["plan", "dry-run", "run"] as const;
export type Mode = (typeof MODES)[number];

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ActionRequest {
  readonly pipeline: string;
  readonly mode: Mode;
  readonly comment: boolean;
  readonly summary: boolean;
  readonly cloudToken: string;
  readonly pullRequest: number | undefined;
}

export interface CommentStore {
  list(): Promise<readonly { id: number; body: string }[]>;
  create(body: string): Promise<void>;
  update(id: number, body: string): Promise<void>;
}

export const FOOTER_LINKS =
  "[Tubeless](https://tubeless.io) · [Schedule this on Tubeless Cloud](https://cloud.tubeless.io)";

export const CLOUD_DISPATCH_UNAVAILABLE =
  "Cloud dispatch is not available yet. This action did not call the Tubeless Cloud HTTP API and did not run the pipeline locally.";

const PLAN_LIMIT = 16_000;
const EXECUTION_LIMIT = 12_000;
const MERMAID_LIMIT = 20_000;

export function parseMode(value: string | undefined): Mode {
  const mode = value === undefined || value.trim() === "" ? "plan" : value.trim();
  if (mode === "plan" || mode === "dry-run" || mode === "run") return mode;
  throw new Error(`mode must be plan, dry-run, or run. Received ${JSON.stringify(value)}.`);
}

export function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Expected true or false. Received ${JSON.stringify(value)}.`);
}

export function parsePullRequest(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const text = value.trim();
  if (!/^[1-9]\d*$/u.test(text))
    throw new Error(`Invalid pull request number ${JSON.stringify(value)}.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number))
    throw new Error(`Invalid pull request number ${JSON.stringify(value)}.`);
  return number;
}

export function readRequest(env: NodeJS.ProcessEnv): ActionRequest {
  return {
    pipeline: (env.INPUT_PIPELINE ?? "").trim(),
    mode: parseMode(env.INPUT_MODE),
    comment: parseFlag(env.INPUT_COMMENT, true),
    summary: parseFlag(env.INPUT_SUMMARY, true),
    cloudToken: env.INPUT_CLOUD_TOKEN ?? "",
    pullRequest: parsePullRequest(env.PR_NUMBER),
  };
}

export function planArgs(pipeline: string, mode: Mode): readonly string[] {
  return mode === "dry-run" ? ["plan", "--dry-run", pipeline] : ["plan", pipeline];
}

export function graphArgs(pipeline: string): readonly string[] {
  return ["graph", pipeline];
}

export function runArgs(pipeline: string, mode: Mode): readonly string[] | undefined {
  if (mode === "dry-run") return ["run", pipeline, "--", "--dry-run"];
  if (mode === "run") return ["run", pipeline];
  return undefined;
}

export function cloudRunBlocked(mode: Mode, cloudToken: string): boolean {
  return mode === "run" && cloudToken.trim() !== "";
}

export function stickyMarker(pipeline: string): string {
  const safe = pipeline.replaceAll(/-{2,}/gu, "-").replaceAll(/[^\w./:@>+-]/gu, "_");
  return `<!-- tubeless-action pipeline="${safe}" -->`;
}

export function resolveTubelessInvocation(
  cwd: string,
  exists: (path: string) => boolean
): { command: string; args: readonly string[] } {
  const localBin = join(cwd, "node_modules", ".bin", "tubeless");
  if (exists(localBin)) return { command: localBin, args: [] };
  const launcher = join(cwd, "dist", "workbench", "workbench-launcher.js");
  if (exists(launcher)) return { command: "bun", args: [launcher] };
  return { command: "bunx", args: ["tubeless"] };
}

export function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.INPUT_CLOUD_TOKEN;
  return env;
}

export function stripAnsi(value: string): string {
  return value.replaceAll(/\u001b\[[0-9;]*m/gu, "");
}

export function commandText(result: CommandResult): string {
  return [result.stdout, result.stderr]
    .map((part) => stripAnsi(part).trim())
    .filter((part) => part !== "")
    .join("\n");
}

function fenced(language: string, source: string, limit: number): string {
  const trimmed = source.trim();
  const truncated = trimmed.length > limit;
  const body = (truncated ? trimmed.slice(0, limit) : trimmed).replaceAll("```", "'''");
  const suffix = truncated ? "\n[truncated]" : "";
  return `\`\`\`${language}\n${body}${suffix}\n\`\`\``;
}

function mermaidSection(graph: CommandResult): string {
  if (graph.exitCode !== 0) return fenced("text", commandText(graph), EXECUTION_LIMIT);
  const body = stripAnsi(graph.stdout).trim().replaceAll("```", "'''");
  if (body === "") return "_The graph was empty._";
  if (body.length > MERMAID_LIMIT)
    return `${fenced("text", body, EXECUTION_LIMIT)}\n\n_Mermaid source was too large to embed._`;
  return `\`\`\`mermaid\n${body}\n\`\`\``;
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

export function renderReport(input: {
  readonly pipeline: string;
  readonly mode: Mode;
  readonly plan: CommandResult;
  readonly graph: CommandResult;
  readonly execution?: CommandResult;
  readonly cloudBlocked: boolean;
}): string {
  const lines = [
    stickyMarker(input.pipeline),
    "",
    "## Tubeless",
    "",
    `${inlineCode(input.pipeline)} · mode ${inlineCode(input.mode)}`,
    "",
    "### Plan",
    "",
    fenced("text", commandText(input.plan), PLAN_LIMIT),
    "",
    "### Graph",
    "",
    mermaidSection(input.graph),
  ];
  if (input.cloudBlocked) lines.push("", "### Tubeless Cloud", "", CLOUD_DISPATCH_UNAVAILABLE);
  if (input.execution) {
    const title = input.mode === "dry-run" ? "Dry run" : "Run";
    lines.push(
      "",
      `### ${title}`,
      "",
      fenced("text", commandText(input.execution), EXECUTION_LIMIT)
    );
  }
  lines.push("", "---", FOOTER_LINKS, "");
  return lines.join("\n");
}

export async function publishStickyComment(
  store: CommentStore,
  body: string,
  marker: string
): Promise<"created" | "updated"> {
  const existing = (await store.list()).find((comment) => comment.body.includes(marker));
  if (existing) {
    await store.update(existing.id, body);
    return "updated";
  }
  await store.create(body);
  return "created";
}

export function displayArgs(args: readonly string[]): string {
  return args.map((arg) => (/[\s"]/u.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}
