import type { PipelineTraceEvent, PipelineTraceExporter } from "../tracing/tracing.js";

export interface BatchingOptions {
  readonly maxEvents: number;
  readonly maxDelayMs: number;
  onFailure(error: unknown): void;
}

export class BatchingTraceExporter implements PipelineTraceExporter {
  readonly #pending: PipelineTraceEvent[] = [];
  #sequence = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: (sequence: number, events: PipelineTraceEvent[]) => Promise<void>,
    private readonly options: BatchingOptions
  ) {}

  export(event: PipelineTraceEvent): void | Promise<void> {
    this.#pending.push(event);
    if (
      (event.name === "pipeline.started" && event.parentRunId === undefined) ||
      this.#pending.length >= this.options.maxEvents
    ) {
      return this.flush();
    }
    this.#timer ??= setTimeout(() => void this.flush().catch(() => {}), this.options.maxDelayMs);
  }

  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const events = this.#pending.splice(0);
    if (events.length > 0) {
      const sequence = this.#sequence++;
      this.#chain = this.#chain.then(async () => {
        try {
          await this.send(sequence, events);
        } catch (error) {
          this.options.onFailure(error);
          throw error;
        }
      });
    }
    return this.#chain;
  }
}
