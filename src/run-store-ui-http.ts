import { isIP } from "node:net";

/** Format a host literal for an HTTP URL or authority. */
export function formatHttpUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/** Normalize a bare HTTP authority, including omission of the default port. */
export function normalizeHttpAuthority(authority: string | undefined): string | undefined {
  if (!authority || /[\s\\/@?#]/.test(authority)) return undefined;
  try {
    const parsed = new URL(`http://${authority}/`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return undefined;
    return parsed.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True for bind addresses that cannot appear in a client Host header. */
export function isUnspecifiedHttpHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/** Hostname that a wildcard listener may trust: localhost or a literal IP. */
export function isLiteralOrLocalhostHttpHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return unbracketed === "localhost" || isIP(unbracketed) !== 0;
}

/** Split a normalized authority into hostname and port (empty port = default). */
export function parseHttpAuthority(
  authority: string | undefined
): { hostname: string; port: string } | undefined {
  const normalized = normalizeHttpAuthority(authority);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(`http://${normalized}/`);
    const hostname = parsed.hostname.startsWith("[")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    return { hostname, port: parsed.port };
  } catch {
    return undefined;
  }
}
