import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { normalizeHttpAuthority } from "./run-store-ui-http.js";

/** Operator-owned configuration. Never serialize this object into the page. */
export interface StudioHosting {
  readonly publicUrl: string;
  readonly origin: string;
  readonly authority: string;
  readonly mount: string;
  readonly trustsAuthority: (authority: string | undefined) => boolean;
  readonly authenticates: (request: IncomingMessage) => boolean;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1]!);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

/** Validate before loading user modules or opening resources. Errors contain no supplied values. */
export function parseStudioHosting(
  publicUrl: string | undefined,
  token: string | undefined
): StudioHosting | undefined {
  if (publicUrl === undefined) {
    if (token !== undefined)
      throw new Error("TUBELESS_STUDIO_GATEWAY_TOKEN requires --public-url.");
    return undefined;
  }
  if (!token || !/^[0-9a-fA-F]{64}$/.test(token)) {
    throw new Error(
      "--public-url requires TUBELESS_STUDIO_GATEWAY_TOKEN containing 64 hexadecimal characters (32 random bytes)."
    );
  }
  const invalidUrl = () =>
    new Error(
      "--public-url must be an absolute HTTPS URL (HTTP only on loopback), with an unreserved ASCII path and no credentials, query, fragment, or dot segments."
    );
  // Inspect the original spelling: URL parsing normalizes dot segments and backslashes.
  const match = /^(https?):\/\/([^/?#\\]+)(\/[^?#\\]*)?$/.exec(publicUrl);
  if (!match || /[\s@]/.test(match[2]!)) throw invalidUrl();
  const rawPath = match[3] ?? "/";
  const segments = rawPath.slice(1).split("/");
  if (segments.at(-1) === "") segments.pop();
  if (
    segments.some(
      (segment) => !/^[A-Za-z0-9_~.-]+$/.test(segment) || segment === "." || segment === ".."
    )
  )
    throw invalidUrl();
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw invalidUrl();
  }
  if (
    url.username ||
    url.password ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw invalidUrl();
  // Do not accept alternate numeric spellings that URL would coerce into loopback.
  if (
    url.protocol === "http:" &&
    !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(match[2]!)
  )
    throw invalidUrl();
  const authority = normalizeHttpAuthority(url.host, url.protocol);
  if (!authority) throw invalidUrl();
  const mount = segments.length ? "/" + segments.join("/") : "";
  const expected = Buffer.from(token, "hex");
  return {
    publicUrl: url.origin + mount + "/",
    origin: url.origin,
    authority,
    mount,
    trustsAuthority: (value) => normalizeHttpAuthority(value, url.protocol) === authority,
    authenticates(request) {
      const header = singleHeader(request, "authorization");
      if (!header || !/^Bearer [0-9a-fA-F]{64}$/.test(header)) return false;
      return timingSafeEqual(expected, Buffer.from(header.slice(7), "hex"));
    },
  };
}

export function hasStudioOrigin(request: IncomingMessage, hosting: StudioHosting): boolean {
  return singleHeader(request, "origin") === hosting.origin;
}

/** Preserve opaque encoded route IDs; only reject ambiguous path structure. */
export function studioRoute(
  rawTarget: string,
  mount: string
): { path: string; search: string } | undefined {
  if (!rawTarget.startsWith("/") || rawTarget.startsWith("//") || /[\\#\s]/.test(rawTarget))
    return undefined;
  const query = rawTarget.indexOf("?");
  const path = query < 0 ? rawTarget : rawTarget.slice(0, query);
  const search = query < 0 ? "" : rawTarget.slice(query);
  if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) return undefined;
  if (path === mount) return { path: "", search };
  if (!path.startsWith(mount + "/")) return undefined;
  const route = path.slice(mount.length);
  if (route.includes("//")) return undefined;
  return { path: route, search };
}
