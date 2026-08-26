import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";

/**
 * One option in an interactive multi-select list.
 * Domain packages supply their own values and labels; this module stays generic.
 */
export interface MultiSelectChoice<T extends string = string> {
  value: T;
  /** Shown in fzf/readline. Defaults to `value`. */
  label?: string;
}

/**
 * Result of a multi-select prompt.
 * - `all`: user chose the explicit all-option (meaning is domain-defined)
 * - `values`: one or more concrete choice values, in choice-list order
 */
export type MultiSelectResult<T extends string = string> =
  | { kind: "all" }
  | { kind: "values"; values: readonly T[] };

export interface PromptMultiSelectOptions<T extends string = string> {
  /** Items the user may pick. */
  choices: readonly MultiSelectChoice<T>[] | readonly T[];
  /**
   * When true, show an "all" row that returns `{ kind: "all" }`.
   * Domains decide what "all" expands to after the prompt returns.
   */
  allowAll?: boolean;
  /** Label for the all-option row. Defaults to `"All"`. */
  allLabel?: string;
  /** Value token recognized as all (input parse + fzf). Defaults to `"all"`. */
  allValue?: string;
  /** Heading printed above the numbered fallback menu. */
  title?: string;
  /** fzf `--header` text. */
  header?: string;
  /** fzf `--prompt` and readline question prefix. Defaults to `"> "`. */
  prompt?: string;
  /** Prefer fzf multi-select when the binary is available. Defaults to true. */
  preferFzf?: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export interface ParseMultiSelectInputOptions {
  allowAll?: boolean;
  allValue?: string;
}

function canUseInteractivePrompt(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream
): boolean {
  const inTty = "isTTY" in stdin && stdin.isTTY === true;
  const outTty = "isTTY" in stdout && stdout.isTTY === true;
  return Boolean(inTty && outTty);
}

function fzfAvailable(): boolean {
  const result = spawnSync("fzf", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

function isStringChoice<T extends string>(choice: MultiSelectChoice<T> | T): choice is T {
  return typeof choice === "string";
}

/** Normalize string or `{ value, label }` choices into a stable list. */
export function normalizeMultiSelectChoices<T extends string>(
  choices: readonly MultiSelectChoice<T>[] | readonly T[]
): MultiSelectChoice<T>[] {
  return choices.map((choice) =>
    isStringChoice(choice)
      ? { value: choice, label: choice }
      : { ...choice, label: choice.label ?? choice.value }
  );
}

function displayLabel(choice: MultiSelectChoice<string>): string {
  return choice.label ?? choice.value;
}

/**
 * Parse a space/comma-separated selection of 1-based indices, choice values,
 * or the all-token. Returns null when the input is empty or unparseable.
 */
export function parseMultiSelectInput<T extends string>(
  input: string,
  choices: readonly MultiSelectChoice<T>[] | readonly T[],
  options: ParseMultiSelectInputOptions = {}
): MultiSelectResult<T> | null {
  const normalized = normalizeMultiSelectChoices(choices);
  const allowAll = options.allowAll ?? false;
  const allValue = (options.allValue ?? "all").toLowerCase();
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  if (allowAll && (trimmed === allValue || trimmed === "*")) {
    return { kind: "all" };
  }

  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const valueByLower = new Map(
    normalized.map((choice) => [choice.value.toLowerCase(), choice.value])
  );
  const selected = new Set<T>();

  for (const token of tokens) {
    if (allowAll && (token === allValue || token === "*")) {
      return { kind: "all" };
    }
    const asIndex = Number(token);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= normalized.length) {
      selected.add(normalized[asIndex - 1]!.value);
      continue;
    }
    const matched = valueByLower.get(token);
    if (matched !== undefined) {
      selected.add(matched);
      continue;
    }
    return null;
  }

  if (selected.size === 0) return null;
  return {
    kind: "values",
    values: normalized.map((choice) => choice.value).filter((value) => selected.has(value)),
  };
}

function promptWithFzf<T extends string>(
  choices: readonly MultiSelectChoice<T>[],
  options: {
    allowAll: boolean;
    allLabel: string;
    allValue: string;
    header: string;
    prompt: string;
  }
): MultiSelectResult<T> | null {
  const lines = [
    ...(options.allowAll ? [`${options.allValue}\t${options.allLabel}`] : []),
    ...choices.map((choice) => `${choice.value}\t${displayLabel(choice)}`),
  ];
  // Candidate list is piped on stdin; fzf opens /dev/tty for the interactive UI.
  const result = spawnSync(
    "fzf",
    [
      "--multi",
      "--delimiter=\t",
      "--with-nth=2..",
      `--header=${options.header}`,
      `--prompt=${options.prompt}`,
      "--height=40%",
      "--reverse",
    ],
    {
      input: `${lines.join("\n")}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    }
  );
  if (result.status !== 0) {
    return null;
  }
  const selectedLines = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (selectedLines.length === 0) return null;

  const allToken = options.allValue.toLowerCase();
  if (
    options.allowAll &&
    selectedLines.some((line) => {
      const key = (line.split("\t")[0] ?? line).toLowerCase();
      return key === allToken;
    })
  ) {
    return { kind: "all" };
  }

  const selected = new Set<T>();
  for (const line of selectedLines) {
    const key = line.split("\t")[0] ?? "";
    const matched = choices.find((choice) => choice.value === key);
    if (matched) selected.add(matched.value);
  }
  if (selected.size === 0) return null;
  return {
    kind: "values",
    values: choices.map((choice) => choice.value).filter((value) => selected.has(value)),
  };
}

async function promptWithReadline<T extends string>(
  choices: readonly MultiSelectChoice<T>[],
  options: {
    allowAll: boolean;
    allLabel: string;
    allValue: string;
    title: string;
    prompt: string;
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
  }
): Promise<MultiSelectResult<T> | null> {
  const output = options.stdout;
  output.write(`${options.title}:\n`);
  if (options.allowAll) {
    output.write(`  ${options.allValue}  ${options.allLabel}\n`);
  }
  choices.forEach((choice, index) => {
    output.write(`  ${String(index + 1).padStart(2, " ")}. ${displayLabel(choice)}\n`);
  });
  const allHint = options.allowAll ? `, or '${options.allValue}'` : "";
  output.write(`\nEnter numbers and/or values (space/comma separated)${allHint}. Empty cancels.\n`);

  const rl = readline.createInterface({ input: options.stdin, output: options.stdout });
  try {
    const answer = await rl.question(
      options.prompt.endsWith(" ") ? options.prompt : `${options.prompt} `
    );
    return parseMultiSelectInput(answer, choices, {
      allowAll: options.allowAll,
      allValue: options.allValue,
    });
  } finally {
    rl.close();
  }
}

/**
 * Interactively multi-select from a list of choices.
 *
 * Prefers fzf multi-select when available; falls back to a numbered prompt.
 * Returns `null` when the user cancels or the session is non-interactive.
 *
 * @example
 * ```ts
 * import { promptMultiSelect } from "tubeless/cli";
 *
 * const picked = await promptMultiSelect({
 *   choices: [
 *     { value: "shard-a", label: "Shard A (east)" },
 *     { value: "shard-b", label: "Shard B (west)" },
 *   ],
 *   allowAll: true,
 *   allLabel: "All shards",
 *   title: "Select shards to process",
 *   prompt: "shards> ",
 * });
 * if (!picked) throw new Error("Selection cancelled");
 * if (picked.kind === "all") runAll();
 * else runSelected(picked.values);
 * ```
 */
export async function promptMultiSelect<T extends string>(
  options: PromptMultiSelectOptions<T>
): Promise<MultiSelectResult<T> | null> {
  const choices = normalizeMultiSelectChoices(options.choices);
  if (choices.length === 0) {
    throw new Error("promptMultiSelect requires at least one choice");
  }

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const preferFzf = options.preferFzf ?? true;
  const allowAll = options.allowAll ?? false;
  const allValue = options.allValue ?? "all";
  const allLabel = options.allLabel ?? "All";
  const title = options.title ?? "Select one or more options";
  const header = options.header ?? "Select options (TAB multi-select, Enter confirm)";
  const prompt = options.prompt ?? "> ";

  if (!canUseInteractivePrompt(stdin, stdout)) {
    return null;
  }

  if (preferFzf && fzfAvailable()) {
    return promptWithFzf(choices, { allowAll, allLabel, allValue, header, prompt });
  }

  return promptWithReadline(choices, {
    allowAll,
    allLabel,
    allValue,
    title,
    prompt,
    stdin,
    stdout,
  });
}
