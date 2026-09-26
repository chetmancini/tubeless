import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { PipelineRunEventReader, PipelineRunEventStore } from "../run-store/run-store.js";
import {
  formatHttpUrlHost,
  isLiteralOrLocalhostHttpHost,
  isUnspecifiedHttpHost,
  normalizeHttpAuthority,
  parseHttpAuthority,
  writeError,
  writeJson,
  writeUnexpectedStudioError,
} from "./run-store-ui-http.js";
import {
  studioHtml,
  PIPELINE_RUN_STUDIO_SCRIPT,
  PIPELINE_RUN_STUDIO_STYLE,
} from "./run-store-ui-page.js";
import { createStudioApiHandler, type PipelineRunStudioApiOptions } from "./run-store-ui-api.js";
import { hasStudioOrigin, studioRoute, type StudioHosting } from "./run-store-ui-hosting.js";
export type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchResult,
} from "./run-store-ui-protocol.js";

const studioStyleCspHash = `'sha256-${createHash("sha256").update(PIPELINE_RUN_STUDIO_STYLE).digest("base64")}'`;
const studioScriptCspHash = `'sha256-${createHash("sha256").update(PIPELINE_RUN_STUDIO_SCRIPT).digest("base64")}'`;
const studioPageCsp = `default-src 'none'; style-src ${studioStyleCspHash}; script-src ${studioScriptCspHash}; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export interface PipelineRunStudioOptions extends PipelineRunStudioApiOptions {
  store: PipelineRunEventReader | PipelineRunEventStore;
  /** Bind address. Defaults to loopback only. */
  host?: string;
  /** HTTP port. Pass `0` to select an available port. Defaults to `4317`. */
  port?: number;
  hosting?: StudioHosting;
}

export interface PipelineRunStudioServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function isAddressInfo(
  address: string | import("node:net").AddressInfo | null
): address is import("node:net").AddressInfo {
  return typeof address !== "string" && address !== null;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Start the local studio against any store and optional execution capability. */
export async function startPipelineRunStudio(
  options: PipelineRunStudioOptions
): Promise<PipelineRunStudioServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4317;
  const hosting = options.hosting;
  const handleApi = createStudioApiHandler({
    ...options,
    history: hosting ? undefined : options.history,
  });
  let ready = true;
  let expectedAuthority: string | undefined;
  const wildcardBind = isUnspecifiedHttpHost(host);
  const isTrustedAuthority = (request: import("node:http").IncomingMessage): boolean => {
    const requestAuthority = normalizeHttpAuthority(request.headers.host);
    if (!requestAuthority || !expectedAuthority) return false;
    if (requestAuthority === expectedAuthority || hosting?.trustsAuthority(request.headers.host))
      return true;
    if (!wildcardBind) return false;
    const requestParts = parseHttpAuthority(requestAuthority);
    const expectedParts = parseHttpAuthority(expectedAuthority);
    return (
      requestParts !== undefined &&
      expectedParts !== undefined &&
      requestParts.port === expectedParts.port &&
      isLiteralOrLocalhostHttpHost(requestParts.hostname)
    );
  };
  const server = createServer(async (request, response) => {
    try {
      if (hosting && !hosting.authenticates(request)) {
        writeError(
          response,
          401,
          "gateway_authentication_required",
          "Gateway authentication failed.",
          "Check the application gateway configuration."
        );
        return;
      }
      if (!isTrustedAuthority(request)) {
        writeError(
          response,
          403,
          "untrusted_host",
          "The request host is not trusted.",
          "Use the exact local Studio URL printed by tubeless ui."
        );
        return;
      }
      if (
        hosting &&
        (request.method === "POST" || request.method === "DELETE") &&
        !hasStudioOrigin(request, hosting)
      ) {
        writeError(
          response,
          403,
          "untrusted_origin",
          "The request origin is not trusted.",
          "Send mutations from the configured Studio origin."
        );
        return;
      }
      const route = studioRoute(request.url ?? "/", hosting?.mount ?? "");
      if (!route) {
        writeError(
          response,
          404,
          "not_found",
          "Studio route not found.",
          "Use the configured Studio URL."
        );
        return;
      }
      if (route.path === "" && (request.method === "GET" || request.method === "HEAD")) {
        response.writeHead(308, {
          "cache-control": "no-store",
          location: hosting!.mount + "/" + route.search,
        });
        response.end();
        return;
      }
      const url = new URL(route.path + route.search, "http://studio.local");
      if (request.method === "GET" && url.pathname === "/api/health") {
        writeJson(response, { ready }, ready ? 200 : 503);
        return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy": studioPageCsp,
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : studioHtml(hosting?.mount ?? ""));
        return;
      }
      await handleApi(request, response, url);
    } catch (error) {
      writeUnexpectedStudioError(response, error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!isAddressInfo(address)) {
    await closeServer(server);
    throw new Error("The local studio did not receive a TCP address.");
  }
  const port = address.port;
  const urlHost = formatHttpUrlHost(host);
  const authority = `${urlHost}:${port}`;
  expectedAuthority = normalizeHttpAuthority(authority);
  if (!expectedAuthority) {
    await closeServer(server);
    throw new Error("The local studio could not normalize its HTTP authority.");
  }
  return {
    host,
    port,
    url: hosting?.publicUrl ?? `http://${authority}`,
    close: () => {
      ready = false;
      return closeServer(server);
    },
  };
}
