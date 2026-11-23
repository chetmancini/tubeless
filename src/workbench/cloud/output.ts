import { isJsonObject } from "../../utilities/canonical-json.js";
import { terminalSafeText } from "../workbench-shared.js";
import { redactCloudText } from "./credentials.js";

function redactKeys(value: Record<string, unknown>, token: string): Record<string, unknown> {
  const keys = Object.keys(value).filter((key) => key.includes(token));
  if (!keys.length) return value;
  const entries = new Map(Object.entries(value));
  let suffix = 2;
  for (const key of keys) {
    const redacted = redactCloudText(key, token);
    let replacement = redacted;
    while (entries.has(replacement)) replacement = `${redacted} (${suffix++})`;
    entries.set(replacement, value[key]);
    entries.delete(key);
  }
  return Object.fromEntries(entries);
}

export function cloudOutput(token?: string) {
  const redact = (value: string) => redactCloudText(value, token);
  return {
    text: (value: string) => terminalSafeText(redact(value)),
    json: (value: unknown) =>
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === "string") return redact(item);
        return token && isJsonObject(item) ? redactKeys(item, token) : item;
      }),
    runUrl(host: string, workspace: string, id: string) {
      const url = new URL(`/app/runs/${encodeURIComponent(redact(id))}`, host);
      url.searchParams.set("workspace", redact(workspace));
      return url.href;
    },
  };
}
