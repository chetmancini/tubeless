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
  writeUnexpectedStudioError,
} from "./run-store-ui-http.js";
import {
  PIPELINE_RUN_STUDIO_HTML,
  PIPELINE_RUN_STUDIO_SCRIPT,
  PIPELINE_RUN_STUDIO_STYLE,
} from "./run-store-ui-page.js";
import { createStudioApiHandler, type PipelineRunStudioApiOptions } from "./run-store-ui-api.js";
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
  const handleApi = createStudioApiHandler(options);
  let expectedAuthority: string | undefined;
  const wildcardBind = isUnspecifiedHttpHost(host);
  const isTrustedAuthority = (request: import("node:http").IncomingMessage): boolean => {
    const requestAuthority = normalizeHttpAuthority(request.headers.host);
    if (!requestAuthority || !expectedAuthority) return false;
    if (requestAuthority === expectedAuthority) return true;
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
      const url = new URL(request.url ?? "/", "http://studio.local");
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
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy": studioPageCsp,
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(PIPELINE_RUN_STUDIO_HTML);
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
    url: `http://${authority}`,
    close: () => closeServer(server),
  };
}
