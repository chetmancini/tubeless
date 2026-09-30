export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function outputItems(body: unknown): Record<string, unknown>[] {
  if (!record(body) || !Array.isArray(body.output) || !body.output.every(record))
    throw new Error("OpenAI returned invalid output items");
  return body.output;
}

export function openaiDecision(output: readonly Record<string, unknown>[]) {
  const calls: { id: string; tool: string; input: unknown }[] = [];
  for (const item of output) {
    if (item.type === "reasoning") continue;
    if (item.type === "message") {
      if (
        !Array.isArray(item.content) ||
        item.content.some((part: unknown) => !record(part) || part.type !== "output_text")
      )
        throw new Error("OpenAI refused the request or returned invalid message content");
      continue;
    }
    if (
      item.type !== "function_call" ||
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string"
    )
      throw new Error("Invalid OpenAI function call");
    let args: unknown;
    try {
      args = JSON.parse(item.arguments);
    } catch {
      throw new Error("OpenAI function arguments must be JSON");
    }
    const key = item.name === "_finish" ? "result" : "input";
    if (!record(args) || Object.keys(args).length !== 1 || !Object.hasOwn(args, key))
      throw new Error(`OpenAI function arguments require exactly one ${key} field`);
    calls.push({ id: item.call_id, tool: item.name, input: args[key] });
  }
  if (calls.length === 0) throw new Error("OpenAI returned no function calls");
  if (calls.some((call) => call.tool === "_finish")) {
    if (calls.length !== 1) throw new Error("OpenAI must finish without other calls");
    return { kind: "finish", result: calls[0]!.input };
  }
  return { kind: "continue", calls };
}

// Wrapping changes the resource root. Only inspect schema positions, never literal
// values in const/enum/default/examples or property names that resemble keywords.
function assertParameterSchema(schema: unknown, path: string): void {
  if (Array.isArray(schema)) {
    schema.forEach((child, index) => assertParameterSchema(child, `${path}[${index}]`));
    return;
  }
  if (!record(schema)) return;
  for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"]) {
    if (Object.hasOwn(schema, keyword))
      throw new Error(
        `OpenAI function parameters require inline schemas; ${keyword} is unsupported at ${path}. Supply an inline inputJsonSchema descriptor.`
      );
  }
  for (const keyword of [
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
  ]) {
    const children = schema[keyword];
    if (record(children)) {
      for (const [name, child] of Object.entries(children))
        assertParameterSchema(child, `${path}.${keyword}[${JSON.stringify(name)}]`);
    }
  }
  for (const keyword of [
    "items",
    "additionalItems",
    "additionalProperties",
    "contains",
    "propertyNames",
    "unevaluatedItems",
    "unevaluatedProperties",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
    "allOf",
    "anyOf",
    "oneOf",
    "prefixItems",
  ])
    assertParameterSchema(schema[keyword], `${path}.${keyword}`);

  const object =
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    Object.hasOwn(schema, "properties");
  if (!object) return;
  if (schema.additionalProperties !== false)
    throw new Error(`OpenAI strict schema at ${path} requires additionalProperties: false`);
  if (schema.properties !== undefined && !record(schema.properties))
    throw new Error(`OpenAI strict schema at ${path} requires an object properties map`);
  const fields = Object.keys(schema.properties ?? {});
  const required = schema.required;
  if (fields.length === 0 && required === undefined) return;
  if (
    !Array.isArray(required) ||
    required.length !== fields.length ||
    new Set(required).size !== fields.length ||
    fields.some((field) => !required.includes(field))
  )
    throw new Error(`OpenAI strict schema at ${path} must require every property exactly once`);
}

export function parameter(name: string, schema: Readonly<Record<string, unknown>>, label = name) {
  assertParameterSchema(schema, label);
  return {
    type: "object",
    properties: { [name]: schema },
    required: [name],
    additionalProperties: false,
  };
}
