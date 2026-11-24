/** Normalize a service origin without allowing credential, path or redirect ambiguity. */
export function normalizeRemoteOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS origin.`);
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    !/^https?:\/\/[^/?#@]+\/?$/i.test(value) ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      `${label} must be an HTTPS origin without credentials, path, query or fragment. HTTP is allowed only for loopback development.`
    );
  }
  return url.origin;
}
