import { remoteProcess, type RemoteProcessContext } from "./process.js";

export async function workerHeaders(
  host: string,
  context: RemoteProcessContext,
  access: "user" | "service"
): Promise<Headers> {
  const headers = new Headers({ accept: "application/json" });
  if (host.startsWith("http:")) return headers;
  if (access === "user") {
    const run = remoteProcess(context);
    const app = `--app=${host}`;
    const getToken = () => run("cloudflared", ["access", "token", app]);
    const jwt = /^[\w-]+\.[\w-]+\.[\w-]+$/;
    try {
      let token = (await getToken().catch(() => "")).trim();
      if (!jwt.test(token) && context.io.stdin?.isTTY) {
        await run("cloudflared", ["access", "login", "--quiet", app], { interactive: true });
        token = (await getToken()).trim();
      }
      if (!jwt.test(token)) throw new Error("Cloudflare Access did not return a token.");
      headers.set("cf-access-token", token);
      return headers;
    } catch {
      throw new Error(
        `Cloudflare Access sign-in failed. Install cloudflared and run cloudflared access login --quiet ${host}, or use an Access service token.`
      );
    }
  }
  const id = context.env.CF_ACCESS_CLIENT_ID;
  const secret = context.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret)
    throw new Error("Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET for this origin.");
  headers.set("CF-Access-Client-Id", id);
  headers.set("CF-Access-Client-Secret", secret);
  return headers;
}
