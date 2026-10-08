import { mapSchema, record, strictParameter, wrapParameter } from "./provider-schema.js";

export const COMPACTION_BETA = "compact-2026-09-04";

// Strict tool use rejects these constraints. The harness still validates the original
// schema, so they move into the description instead of reaching the grammar compiler.
const NUMERIC_AND_LENGTH = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "minProperties",
  "maxProperties",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
];
const FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function strictSubset(schema: Record<string, unknown>): Record<string, unknown> {
  const moved: Record<string, unknown> = {};
  const copy = { ...schema };
  for (const keyword of NUMERIC_AND_LENGTH) {
    if (Object.hasOwn(copy, keyword)) {
      moved[keyword] = copy[keyword];
      delete copy[keyword];
    }
  }
  if (typeof copy.minItems === "number" && copy.minItems > 1) {
    moved.minItems = copy.minItems;
    delete copy.minItems;
  }
  // Strict enums accept only strings, numbers, booleans, and null.
  if (
    Array.isArray(copy.enum) &&
    copy.enum.some((value) => value !== null && typeof value === "object")
  ) {
    moved.enum = copy.enum;
    delete copy.enum;
  }
  if (typeof copy.format === "string" && !FORMATS.has(copy.format)) {
    moved.format = copy.format;
    delete copy.format;
  }
  if (Object.keys(moved).length === 0) return copy;
  const note = `Constraints: ${JSON.stringify(moved)}`;
  copy.description =
    typeof copy.description === "string" && copy.description
      ? `${copy.description}\n${note}`
      : note;
  return copy;
}

/** Build a Messages API tool whose arguments carry the value in one wrapped field. */
export function anthropicTool(
  name: string,
  description: string,
  field: "input" | "result",
  schema: Readonly<Record<string, unknown>>,
  strict: boolean
) {
  if (!strict) {
    // Wrapping still relocates the reference root, so references stay rejected.
    strictParameter(field, schema, `tool ${name}`, {
      provider: "Anthropic",
      closedObjects: false,
      requireEveryProperty: false,
    });
    return { name, description, input_schema: wrapParameter(field, schema) };
  }
  // Check the schema the provider will see: stripped constraints are enforced only by
  // the harness, so their subschemas need not meet strict-mode object rules.
  // SAFETY: mapSchema returns a copied record when given a record.
  const visible = mapSchema(schema, strictSubset) as Record<string, unknown>;
  return {
    name,
    description,
    input_schema: strictParameter(field, visible, `tool ${name}`, {
      provider: "Anthropic",
      closedObjects: true,
      requireEveryProperty: false,
    }),
    strict: true,
  };
}

/** Validate a Messages API response and return its stop reason and content blocks. */
export function anthropicMessage(body: unknown) {
  if (
    !record(body) ||
    body.type !== "message" ||
    typeof body.stop_reason !== "string" ||
    !Array.isArray(body.content) ||
    !body.content.every(record)
  )
    throw new Error("Anthropic returned an invalid message");
  return { stopReason: body.stop_reason, content: body.content };
}

/** Map tool_use blocks to a harness decision; null when the model replied without tools. */
export function anthropicDecision(content: readonly Record<string, unknown>[]) {
  const calls: { id: string; tool: string; input: unknown }[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || typeof block.name !== "string" || !record(block.input))
      throw new Error("Invalid Anthropic tool call");
    const key = block.name === "_finish" ? "result" : "input";
    if (Object.keys(block.input).length !== 1 || !Object.hasOwn(block.input, key))
      throw new Error(`Anthropic tool arguments require exactly one ${key} field`);
    calls.push({ id: block.id, tool: block.name, input: block.input[key] });
  }
  if (calls.length === 0) return null;
  if (calls.some((call) => call.tool === "_finish")) {
    if (calls.length !== 1) throw new Error("Anthropic must finish without other calls");
    return { kind: "finish", result: calls[0]!.input };
  }
  return { kind: "continue", calls };
}

/** Whether a message list carries a compaction block, which requires the beta header. */
export function carriesCompaction(messages: readonly unknown[]): boolean {
  const first = messages[0];
  return (
    record(first) &&
    Array.isArray(first.content) &&
    record(first.content[0]) &&
    first.content[0].type === "compaction"
  );
}
