import type { ProjectTraceContext } from "../project/pipeline-project.js";
import {
  composeTraceExporters,
  type PipelineTraceExporter,
  type PipelineTraceExporterOptions,
} from "../tracing/tracing.js";
import type { PipelineTracingOptions } from "../tracing/tracing-contracts.js";

export interface LaunchTracing {
  /** Invoke factories once, retaining partial initialization for close(). */
  prepare(): PipelineTracingOptions | undefined;
  /** Abort and drain application exporters if execution never reached a run. */
  close(): Promise<void>;
}

/** Own factory setup and rollback; ordinary runs retain core's trace flushing. */
export function createLaunchTracing<TContext extends ProjectTraceContext>(options: {
  readonly context: TContext;
  readonly configurations: readonly (PipelineTraceExporterOptions<TContext> | undefined)[];
  readonly exporters: readonly PipelineTraceExporter[];
  readonly wrapExporter?: (exporter: PipelineTraceExporter) => PipelineTraceExporter;
}): LaunchTracing {
  const lifetime = new AbortController();
  const context = {
    ...options.context,
    signal: AbortSignal.any([options.context.signal, lifetime.signal]),
  };
  const owned = new Map<PipelineTraceExporter, PipelineTraceExporter>();
  let started = false;
  return {
    async close() {
      if (started) return;
      lifetime.abort(new DOMException("The launch ended before pipeline execution.", "AbortError"));
      const exporters = [...owned.values()];
      owned.clear();
      await Promise.allSettled(exporters.map(async (exporter) => exporter.flush?.()));
    },
    prepare() {
      const exporters = [...options.exporters];
      for (const configuration of options.configurations) {
        for (const exporter of configuration?.exporters(context) ?? []) {
          let wrapped = owned.get(exporter);
          if (!wrapped) {
            wrapped = options.wrapExporter?.(exporter) ?? exporter;
            owned.set(exporter, wrapped);
          }
          exporters.push(wrapped);
        }
      }
      if (exporters.length === 0) return undefined;
      const composed = composeTraceExporters(exporters);
      return {
        exporter: {
          export(event) {
            started = true;
            return composed.export(event);
          },
          flush: () => composed.flush?.(),
        },
        onExporterError: async (error) => {
          await Promise.all(
            options.configurations.map(async (configuration) =>
              configuration?.onExporterError?.(error)
            )
          );
        },
      };
    },
  };
}
