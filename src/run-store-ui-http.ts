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
