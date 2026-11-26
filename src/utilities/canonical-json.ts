/** Narrow a decoded JSON object before reading fields. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sort validated JSON object keys recursively, preserving array order. */
export function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalJsonValue(child)])
    );
  }
  return value;
}

/** SHA-256/base64url of canonical UTF-8 JSON. */
export async function digestCanonicalJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalJsonValue(value)));
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return btoa(String.fromCharCode(...result))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .slice(0, -1);
}
