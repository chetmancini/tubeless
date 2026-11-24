export const STUDIO_API_PATH = {
  capabilities: "/api/capabilities",
  commands: "/api/commands",
  definitions: "/api/definitions",
  definitionRuns: "/api/definitions/runs",
  health: "/api/health",
  history: "/api/history",
  runs: "/api/runs",
  snapshot: "/api/snapshot",
} as const;

export const STUDIO_API_ACTION = {
  cancel: "cancel",
  children: "children",
  launch: "runs",
  plan: "plan",
  transcript: "transcript",
} as const;

export const STUDIO_GUARD_HEADER = {
  cancel: "x-tubeless-studio-cancel",
  clear: "x-tubeless-studio-clear-history",
  launch: "x-tubeless-studio-launch",
  plan: "x-tubeless-studio-plan",
} as const;

export const STUDIO_GUARD_VALUE = "1";

type CollectionPath = (typeof STUDIO_API_PATH)["commands" | "runs"];
type Action = (typeof STUDIO_API_ACTION)[keyof typeof STUDIO_API_ACTION];

export function studioResourcePath(collection: CollectionPath, id: string, action?: Action) {
  return collection + "/" + encodeURIComponent(id) + (action ? "/" + action : "");
}

export function parseStudioResourcePath(
  pathname: string,
  collection: CollectionPath
): { encodedId: string; action?: string } | undefined {
  if (!pathname.startsWith(collection + "/")) return undefined;
  const path = /^([^/]+)(?:\/([^/]+))?$/.exec(pathname.slice(collection.length + 1));
  return path ? { encodedId: path[1], action: path[2] } : undefined;
}
