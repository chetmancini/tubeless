import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, request } from "node:https";
import { createSqliteLaunchStoreFixture } from "../hosting/launch-store-sqlite.test-support.js";
import { createHostedCollector } from "../hosting/collector-http.js";
import { provisionCollectorAttempt } from "../hosting/collector-credentials.js";
import { toFetchRequest, writeFetchResponse } from "../studio/server/node-http.js";

export async function workerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-worker-"));
  const certificate = join(directory, "certificate.pem");
  const keyFile = join(directory, "key.pem");
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ]);
  const ca = await readFile(certificate);
  const database = join(directory, "history.sqlite");
  const fixture = createSqliteLaunchStoreFixture(database);
  const state = {
    fixture,
    collector: createHostedCollector({ store: fixture.store }),
    dropClaim: false,
    dropBatchAndRestart: false,
    dropFailure: false,
    unavailableBatches: false,
    unavailableFailure: false,
    requests: [] as { operation: string; body: Uint8Array; workerId: string | null }[],
    failureWhileAlive: false,
    pid: undefined as number | undefined,
  };
  const now = Date.now();
  const token = await provisionCollectorAttempt(
    state.fixture.store,
    {
      launchId: "launch",
      attemptId: "attempt",
      commandId: "parent",
      pipelineId: "parent",
      deploymentId: "revision-1",
      createdAtMs: now,
    },
    now + 60_000
  );
  let baseUrl = "";
  const server = createServer({ key: await readFile(keyFile), cert: ca }, (incoming, target) => {
    void (async () => {
      const source = toFetchRequest(incoming);
      const bytes = new Uint8Array(await source.arrayBuffer());
      const operation = incoming.url!.split("/").at(-1)!;
      state.requests.push({
        operation,
        body: bytes,
        workerId: source.headers.get("x-tubeless-worker-id"),
      });
      if (operation === "failure" && state.pid !== undefined) {
        try {
          process.kill(state.pid, 0);
          state.failureWhileAlive = true;
        } catch {
          /* Exit was observed. */
        }
      }
      if (
        (operation === "batches" && state.unavailableBatches) ||
        (operation === "failure" && state.unavailableFailure)
      ) {
        await writeFetchResponse(target, new Response(null, { status: 503 }), "POST");
        return;
      }
      const response = await state.collector.fetch(
        new Request(`${baseUrl}${incoming.url}`, {
          method: source.method,
          headers: source.headers,
          body: bytes,
        })
      );
      if (operation === "admit" && state.dropClaim) {
        state.dropClaim = false;
        target.destroy();
        return;
      }
      if (operation === "batches" && state.dropBatchAndRestart) {
        state.dropBatchAndRestart = false;
        state.fixture.store.close();
        state.fixture = createSqliteLaunchStoreFixture(database);
        state.collector = createHostedCollector({ store: state.fixture.store });
        target.destroy();
        return;
      }
      if (operation === "failure" && state.dropFailure) {
        state.dropFailure = false;
        target.destroy();
        return;
      }
      await writeFetchResponse(target, response, incoming.method ?? "POST");
    })().catch(() => target.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TLS listener address.");
  baseUrl = `https://127.0.0.1:${address.port}`;
  // Trust only this test CA; production delivery keeps normal TLS verification enabled.
  const trustedFetch: typeof fetch = (input, init) =>
    new Promise((resolve, reject) => {
      const req = request(
        String(input),
        {
          ca,
          method: init?.method,
          headers: Object.fromEntries(new Headers(init?.headers)),
          signal: init?.signal ?? undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", () => reject(new TypeError("Test HTTPS response failed.")));
          response.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers: Object.fromEntries(
                  Object.entries(response.headers).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string"
                  )
                ),
              })
            )
          );
        }
      );
      req.on("error", () => reject(new TypeError("Test HTTPS request failed.")));
      req.end(init?.body);
    });
  const effectFile = join(directory, "effects");
  const importFile = join(directory, "imports");
  const moduleFile = join(directory, "pipeline.mjs");
  const core = new URL("../../dist/core/pipeline.js", import.meta.url).href;
  const cli = new URL("../../dist/cli/cli.js", import.meta.url).href;
  async function writeModule(mode = "nested") {
    await writeFile(
      moduleFile,
      `
      import { createSteps, definePipeline } from ${JSON.stringify(core)};
      import { definePipelineCommand } from ${JSON.stringify(cli)};
      import { appendFile } from 'node:fs/promises';
      await appendFile(${JSON.stringify(importFile)}, process.pid + '\\n');
      if (${JSON.stringify(mode)} === 'ipc-noise') {
        process.send('application message');
        process.send({ type: 'claimed', workerId: 42 });
        process.send({ type: 'done', result: { status: 'history-confirmed', unexpected: true } });
      }
      if (${JSON.stringify(mode)} === 'setup-hang') await new Promise(() => {});
      const { step, fromPipeline } = createSteps();
      const leaf = step('work', {
        description: ${mode === "oversized" ? "'x'.repeat(1100000)" : "'record a process effect'"},
        run: async (_inputs, context) => {
          const exposed = [...process.argv, ...Object.values(process.env)].some(value => /[a-f0-9]{32}\\.[a-f0-9]{64}/.test(value ?? ''));
          if (exposed) throw new Error('Collector credential exposed to argv or environment');
          await appendFile(${JSON.stringify(effectFile)}, process.pid + '\\n');
          if (${JSON.stringify(mode)} === 'hang') while (true) {}
          if (${JSON.stringify(mode)} === 'stall') await new Promise(() => {});
          if (${JSON.stringify(mode)} === 'wait') await new Promise((_, reject) => {
            if (context.signal.aborted) reject(context.signal.reason);
            else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
          });
          if (${JSON.stringify(mode)} === 'crash') {
            await new Promise(resolve => setTimeout(resolve, 100));
            process.kill(process.pid, 'SIGKILL');
          }
          return 'done';
        }
      });
      const child = definePipeline({ id: 'child', steps: [leaf], finalize: leaf });
      const nested = fromPipeline('nested', { pipeline: child, mapOptions: () => ({}) });
      const parent = definePipeline({ id: 'parent', steps: [nested], finalize: nested });
      const command = definePipelineCommand(parent, { params: [] });
      if (${JSON.stringify(mode)} === 'partial') command.execute = async (_values, context) => {
        await context.pipelineContext.tracing.exporter.export({
          version: 3, name: 'pipeline.started', pipelineId: 'parent', runId: 'partial-root', timestampMs: Date.now(),
          payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
        });
      };
      export default command;
    `
    );
    return pathToFileURL(moduleFile);
  }
  const module = await writeModule();
  return {
    directory,
    state,
    token,
    baseUrl,
    module,
    writeModule,
    effectFile,
    importFile,
    workerOptions: {
      job: {
        launchId: "launch",
        attemptId: "attempt",
        commandId: "parent",
        values: {},
        maxRunDurationMs: 20000,
      },
      baseUrl,
      token,
      module,
      deploymentId: "revision-1",
      cwd: directory,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
      fetch: trustedFetch,
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      state.fixture.store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
