import type { PipelineRunEventReader } from "../run-store/run-store.js";
import { createStudioApiHandler } from "../studio/server/api.js";
import { createStudioRequestHandler } from "../studio/server/handler.js";
import { createStudioPage } from "../studio/server/page.js";
import type { PipelineRunStudioLauncher } from "../studio/shared/protocol.js";
import type { PipelineRunStudioHistoryMaintenance } from "../studio/server/state.js";
import type { LaunchActor, StudioLaunchMetadata } from "../studio/shared/launch-metadata.js";

export interface StudioHostOptions {
  readonly store: Pick<PipelineRunEventReader, "listEvents" | "transcripts">;
  readonly history?: PipelineRunStudioHistoryMaintenance;
  readonly launchMetadata?: { forRun(runId: string): Promise<StudioLaunchMetadata | undefined> };
  readonly launcher?: PipelineRunStudioLauncher;
  readonly clientScript: string;
  readonly authenticate?: (
    request: Request
  ) => Response | undefined | Promise<Response | undefined>;
}

export interface StudioHost {
  fetch(request: Request, actor?: LaunchActor): Promise<Response>;
}

/** Compose Studio for a host whose platform already routed the request by hostname. */
export async function createStudioHost(options: StudioHostOptions): Promise<StudioHost> {
  const api = createStudioApiHandler({
    store: options.store,
    launcher: options.launcher,
    history: options.history,
    launchMetadata: options.launchMetadata,
  });
  const page = await createStudioPage(options.clientScript);
  const handle = createStudioRequestHandler({
    api,
    page,
    mount: "",
    authenticate: options.authenticate,
    trustsAuthority: () => true,
    allowedOrigin: (request) => new URL(request.url).origin,
    isReady: () => true,
  });
  return {
    fetch(request, actor) {
      const url = new URL(request.url);
      return handle(request, { rawTarget: url.pathname + url.search, authority: url.host, actor });
    },
  };
}
