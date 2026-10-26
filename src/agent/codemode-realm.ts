// Shared by every executor that runs scripts with Tubeless's in-sandbox setup. The Node worker
// evaluates REALM_SETUP inside its vm context; the Cloudflare executor embeds it, and these
// helpers' source text, in a Dynamic Worker module. Keep the helpers self-contained.

/**
 * In-sandbox setup: `(bridge, names, maxLines, maxCharacters) => { tools, console, finish }`.
 * It runs before model code and creates `tools` and `console` inside the sandbox, so scripts
 * reach only sandbox-local objects. The host bridge stays in this closure and exchanges JSON
 * text only. Scripts receive `tools` and `console` as parameters.
 */
export const REALM_SETUP = `(function (bridge, names, maxLines, maxCharacters) {
  "use strict";
  const { parse, stringify } = JSON;
  const freeze = Object.freeze;
  const logs = [];
  let characters = 0;
  let truncated = false;
  const text = (value) => {
    if (typeof value === "string") return value;
    try {
      const json = stringify(value);
      if (json !== undefined) return json;
    } catch {}
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  };
  const write = (...values) => {
    let line = "";
    for (let index = 0; index < values.length; index++)
      line += (index === 0 ? "" : " ") + text(values[index]);
    if (logs.length >= maxLines || characters + line.length > maxCharacters) {
      truncated = true;
      return;
    }
    logs.push(line);
    characters += line.length;
  };
  const tools = {};
  for (const name of parse(names)) {
    tools[name] = async (input) => {
      const reply = parse(await bridge(name, stringify(input === undefined ? null : input) ?? "null"));
      if (reply.ok) return reply.value;
      const error = new Error(reply.message);
      error.name = "ToolError";
      error.code = reply.code;
      throw error;
    };
  }
  return {
    tools: freeze(tools),
    console: freeze({ log: write, info: write, warn: write, error: write, debug: write }),
    finish(value) {
      let result;
      try {
        result = value === undefined ? "null" : (stringify(value) ?? "null");
      } catch {}
      return { result, logs: stringify(logs), truncated };
    },
  };
})`;

/** Script modules and filenames are named `codemode.js`, so error locations refer to model code. */
export const SCRIPT_FILENAME = "codemode.js";

/** Read a script-thrown value defensively; getters and coercions run script code. */
export function describeScriptError(error: unknown): string {
  try {
    if (error === null || typeof error !== "object") return String(error);
    const { name, message, code, stack } = error as Record<string, unknown>;
    const location = typeof stack === "string" ? /codemode\.js:(\d+)(?::(\d+))?/.exec(stack) : null;
    const label =
      typeof code === "string"
        ? `${code}: `
        : typeof name === "string" && name !== "Error"
          ? `${name}: `
          : "";
    const position = location
      ? ` (line ${location[1]}${location[2] ? `, column ${location[2]}` : ""})`
      : "";
    return `${label}${String(message)}${position}`;
  } catch {
    return "Script failed with an unprintable error";
  }
}

/** Decode the setup's JSON log text, keeping only string lines. */
export function scriptLogLines(text: unknown): string[] {
  try {
    const parsed: unknown = typeof text === "string" ? JSON.parse(text) : undefined;
    return Array.isArray(parsed) ? parsed.filter((line) => typeof line === "string") : [];
  } catch {
    return [];
  }
}
