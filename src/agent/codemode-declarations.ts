type Json = Readonly<Record<string, unknown>>;

/** One script-callable tool, described by its model-facing descriptors. */
export interface CodemodeDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputJsonSchema: Json;
  readonly outputJsonSchema?: Json;
}

const MAX_DEPTH = 12;
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const key = (name: string) => (identifier.test(name) ? name : JSON.stringify(name));

/** Keep comments single-purpose: no early terminators, bounded and trimmed. */
function comment(text: string, indent: string): string[] {
  const lines = text.replaceAll("*/", "*\\/").trim().split(/\r?\n/);
  if (lines.length === 1 && lines[0]!.length <= 100) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`];
}

function union(types: readonly string[]): string {
  const unique = [...new Set(types)];
  if (unique.includes("unknown")) return "unknown";
  return unique.length === 0 ? "never" : unique.join(" | ");
}

/** Parenthesize only top-level unions and intersections; nested object members need none. */
function wrap(type: string): string {
  let depth = 0;
  for (const character of type) {
    if ("{[(<".includes(character)) depth++;
    else if ("}])>".includes(character)) depth--;
    else if (depth === 0 && (character === "|" || character === "&")) return `(${type})`;
  }
  return type;
}

/** Rendering stops once any fragment, or the whole declaration, exceeds its character budget. */
class BudgetExceeded extends Error {}

interface Context {
  readonly root: Json;
  readonly maxCharacters: number;
}

function bounded(context: Context, text: string): string {
  if (text.length > context.maxCharacters) throw new BudgetExceeded();
  return text;
}

/** Resolve a local definition reference, decoding URI and JSON Pointer escapes. */
function definition(context: Context, ref: string): unknown {
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(match[2]!);
  } catch {
    return undefined;
  }
  const definitions = context.root[match[1]!];
  return isRecord(definitions)
    ? definitions[name.replaceAll("~1", "/").replaceAll("~0", "~")]
    : undefined;
}

/** Render a JSON Schema fragment as a TypeScript type; unsupported constructs become unknown. */
function render(schema: unknown, context: Context, indent: string, depth: number): string {
  if (schema === false) return "never";
  if (!isRecord(schema) || depth > MAX_DEPTH) return "unknown";
  if (typeof schema.$ref === "string") {
    const target = definition(context, schema.$ref);
    return target === undefined ? "unknown" : render(target, context, indent, depth + 1);
  }
  if (Object.hasOwn(schema, "const"))
    return bounded(context, JSON.stringify(schema.const) ?? "unknown");
  if (Array.isArray(schema.enum))
    return bounded(context, union(schema.enum.map((value) => JSON.stringify(value))));
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches))
      return bounded(
        context,
        union(branches.map((branch) => render(branch, context, indent, depth + 1)))
      );
  }
  if (Array.isArray(schema.allOf))
    return bounded(
      context,
      schema.allOf.map((part) => wrap(render(part, context, indent, depth + 1))).join(" & ")
    );
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 1)
    return bounded(
      context,
      union(types.map((type) => render({ ...schema, type }, context, indent, depth)))
    );
  switch (types[0]) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return Array.isArray(schema.prefixItems)
        ? tuple(schema, schema.prefixItems, context, indent, depth)
        : bounded(context, `${wrap(render(schema.items ?? true, context, indent, depth + 1))}[]`);
    case "object":
      return object(schema, context, indent, depth);
    default:
      return isRecord(schema.properties) ? object(schema, context, indent, depth) : "unknown";
  }
}

/**
 * Prefix items are positional, not a fixed length: entries past `minItems` are optional, and
 * later entries follow `items` unless it is false.
 */
function tuple(
  schema: Json,
  prefix: readonly unknown[],
  context: Context,
  indent: string,
  depth: number
): string {
  const required = typeof schema.minItems === "number" ? schema.minItems : 0;
  const entries = prefix.map(
    (item, index) =>
      `${wrap(render(item, context, indent, depth + 1))}${index < required ? "" : "?"}`
  );
  if (schema.items !== false)
    entries.push(`...${wrap(render(schema.items ?? true, context, indent, depth + 1))}[]`);
  return bounded(context, `[${entries.join(", ")}]`);
}

function object(schema: Json, context: Context, indent: string, depth: number): string {
  const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const extra = schema.additionalProperties;
  if (properties.length === 0)
    return extra === false
      ? "{}"
      : bounded(
          context,
          `Record<string, ${isRecord(extra) ? render(extra, context, indent, depth + 1) : "unknown"}>`
        );
  const inner = `${indent}  `;
  const lines = ["{"];
  const named: string[] = [];
  let characters = 1;
  const push = (...added: string[]) => {
    for (const line of added) {
      characters += line.length + 1;
      if (characters > context.maxCharacters) throw new BudgetExceeded();
      lines.push(line);
    }
  };
  for (const [name, property] of properties) {
    if (
      isRecord(property) &&
      typeof property.description === "string" &&
      property.description.trim()
    )
      push(...comment(property.description, inner));
    const optional = required.has(name) ? "" : "?";
    const type = render(property, context, inner, depth + 1);
    named.push(type);
    push(`${inner}${key(name)}${optional}: ${type};`);
  }
  // A TypeScript index signature also constrains named properties, so it must admit them.
  if (isRecord(extra))
    push(
      `${inner}[key: string]: ${union([render(extra, context, inner, depth + 1), ...named].map(wrap))};`
    );
  push(`${indent}}`);
  return lines.join("\n");
}

/** Render one schema as a TypeScript type, or undefined when it exceeds `maxCharacters`. */
export function renderSchemaType(schema: Json, maxCharacters: number): string | undefined {
  try {
    return render(schema, { root: schema, maxCharacters }, "", 0);
  } catch (error) {
    if (error instanceof BudgetExceeded) return undefined;
    throw error;
  }
}

/**
 * Render `declare const tools` for script-callable capabilities in registry order, or
 * undefined when the declarations exceed `maxCharacters`.
 */
export function codemodeDeclarations(
  tools: readonly CodemodeDeclaration[],
  maxCharacters = Number.POSITIVE_INFINITY
): string | undefined {
  const lines = ["declare const tools: {"];
  let characters = lines[0]!.length;
  try {
    for (const tool of tools) {
      const input = render(
        tool.inputJsonSchema,
        { root: tool.inputJsonSchema, maxCharacters },
        "  ",
        0
      );
      const output = tool.outputJsonSchema
        ? render(tool.outputJsonSchema, { root: tool.outputJsonSchema, maxCharacters }, "  ", 0)
        : "unknown";
      for (const line of [
        ...comment(tool.description, "  "),
        `  ${key(tool.name)}(input: ${input}): Promise<${output}>;`,
      ]) {
        characters += line.length + 1;
        if (characters > maxCharacters) return undefined;
        lines.push(line);
      }
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) return undefined;
    throw error;
  }
  lines.push("};");
  return lines.join("\n");
}
