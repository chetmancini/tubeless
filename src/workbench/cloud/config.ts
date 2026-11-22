import { normalizeRemoteOrigin } from "../workbench-remote-io.js";

const DEFAULT_CLOUD_HOST = "https://cloud.tubeless.io";

export function normalizeCloudHost(value: string): string {
  return normalizeRemoteOrigin(value, "Cloud host");
}

export function resolveCloudHost(explicitHost?: string): string {
  return normalizeCloudHost(explicitHost ?? DEFAULT_CLOUD_HOST);
}
