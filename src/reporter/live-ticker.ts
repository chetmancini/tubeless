import { writeSync } from "node:fs";
import { isatty } from "node:tty";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import {
  currentSpinner,
  hasLiveAnimation,
  paintLiveLines,
  TICKER_ANSI,
  TickerFrame,
} from "./live-ticker-frame.js";
import {
  TickerWorkerState,
  type LiveTickerWorkerData,
  type TickerWorkerMessage,
} from "./live-ticker-protocol.js";

const OUTPUT_LOCK_TIMEOUT_MS = 50;

export interface LiveTicker {
  setLines(lines: readonly string[], logPane?: readonly string[]): void;
  writeLog(text: string): void;
  dispose(): void;
}

export interface LiveTickerOptions {
  columns?: number;
  getColumns?(): number | undefined;
  fd?: number;
  refreshIntervalMs: number;
  unicode: boolean;
  color?: boolean;
  write(chunk: string): void;
  workerUrl?: URL;
}

function resolveColumns(options: LiveTickerOptions): number | undefined {
  return options.getColumns?.() ?? options.columns;
}

function createInlineTicker(
  options: LiveTickerOptions,
  adoptedPaintedLines: readonly string[] = []
): LiveTicker {
  let disposed = false;
  let lines: readonly string[] = [];
  let logPane: readonly string[] | undefined;
  const frame = new TickerFrame((chunk) => options.write(chunk), adoptedPaintedLines);
  const redraw = (): void => {
    if (disposed) return;
    const columns = resolveColumns(options);
    frame.redraw(
      paintLiveLines(
        lines,
        currentSpinner(options.unicode, options.refreshIntervalMs),
        Date.now(),
        columns,
        options.color === true,
        options.unicode,
        logPane
      ),
      columns
    );
  };

  const timer = setInterval(() => {
    if (disposed || !hasLiveAnimation(lines)) {
      return;
    }
    redraw();
  }, options.refreshIntervalMs);
  timer.unref();

  return {
    setLines(nextLines, nextLogPane) {
      lines = nextLines;
      logPane = nextLogPane;
      redraw();
    },
    writeLog(text) {
      if (disposed) {
        options.write(text);
        return;
      }
      frame.clear(resolveColumns(options));
      options.write(text);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      frame.showCursor();
    },
  };
}

function resolveLiveTickerWorkerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../../dist/reporter/live-ticker-worker.js", import.meta.url)
    : new URL("./live-ticker-worker.js", import.meta.url);
}

function fileWorkerExecArgv(argv: readonly string[] = process.execArgv): string[] {
  const next: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-type") {
      index += 1;
    } else if (!arg.startsWith("--input-type=")) {
      next.push(arg);
    }
  }
  return next;
}

function createWorkerTicker(options: LiveTickerOptions & { fd: number }): LiveTicker {
  const state = new TickerWorkerState();
  const { port1: framePort, port2: workerFramePort } = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(options.workerUrl ?? resolveLiveTickerWorkerUrl(), {
      execArgv: fileWorkerExecArgv(),
      transferList: [workerFramePort],
      workerData: {
        color: options.color === true,
        columns: resolveColumns(options),
        fd: options.fd,
        framePort: workerFramePort,
        refreshIntervalMs: options.refreshIntervalMs,
        stateBuffer: state.buffer,
        unicode: options.unicode,
      } satisfies LiveTickerWorkerData,
    });
  } catch (error) {
    framePort.close();
    workerFramePort.close();
    throw error;
  }
  let paintedLines: readonly string[] = [];
  framePort.on("message", (nextLines: string[]) => {
    paintedLines = nextLines;
  });
  framePort.unref();
  let disposed = false;
  let inlineFallback: LiveTicker | undefined;
  let lines: readonly string[] = [];
  let logPane: readonly string[] | undefined;
  const pendingLogs: string[] = [];
  let acknowledgedLogs = 0;

  const restoreCursor = (): void => {
    try {
      if (isatty(options.fd)) {
        writeSync(options.fd, TICKER_ANSI.showCursor);
      } else {
        options.write(TICKER_ANSI.showCursor);
      }
    } catch {
      // The output may remain unavailable; cursor restore is best-effort.
    }
  };

  const dropAcknowledgedLogs = (): void => {
    const accepted = state.acceptedLogs;
    pendingLogs.splice(0, accepted - acknowledgedLogs);
    acknowledgedLogs = accepted;
  };

  const replayThrough = (ticker: LiveTicker): void => {
    dropAcknowledgedLogs();
    for (const text of pendingLogs) ticker.writeLog(text);
    pendingLogs.length = 0;
    ticker.setLines([...lines], logPane);
  };

  const createFallback = (): LiveTicker | undefined => {
    if (!state.claimOutput(OUTPUT_LOCK_TIMEOUT_MS)) return undefined;
    // dispose() blocks the event loop. Drain snapshots synchronously after taking
    // the output lock so adoption includes the worker's last completed paint.
    let snapshot;
    while ((snapshot = receiveMessageOnPort(framePort)) !== undefined) {
      paintedLines = snapshot.message as string[];
    }
    framePort.close();
    const ticker = createInlineTicker(options, paintedLines);
    replayThrough(ticker);
    return ticker;
  };

  const failToInline = (): void => {
    if (disposed || inlineFallback) return;
    state.releaseOutputAfterWorkerExit();
    inlineFallback = createFallback();
  };

  worker.on("error", () => void worker.terminate());
  worker.on("exit", () => failToInline());
  worker.unref();

  return {
    setLines(nextLines, nextLogPane) {
      if (disposed) return;
      lines = nextLines;
      logPane = nextLogPane;
      if (inlineFallback) {
        inlineFallback.setLines(nextLines, nextLogPane);
        return;
      }
      worker.postMessage({
        columns: resolveColumns(options),
        lines: [...nextLines],
        logPane,
        type: "lines",
      } satisfies TickerWorkerMessage);
    },
    writeLog(text) {
      if (inlineFallback) {
        inlineFallback.writeLog(text);
        return;
      }
      if (disposed) {
        options.write(text);
        return;
      }
      dropAcknowledgedLogs();
      pendingLogs.push(text);
      worker.postMessage({
        columns: resolveColumns(options),
        text,
        type: "log",
      } satisfies TickerWorkerMessage);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (inlineFallback) {
        inlineFallback.dispose();
        void worker.terminate();
        return;
      }
      let restoreCursorAfterTerminate = false;
      try {
        let workerStopped = false;
        try {
          worker.postMessage({
            columns: resolveColumns(options),
            lines: [...lines],
            logPane,
            type: "stop",
          } satisfies TickerWorkerMessage);
          workerStopped = state.waitForStop(500);
        } catch {
          // The worker is unavailable; render its retained state below.
        }
        if (!workerStopped) {
          const ticker = createFallback();
          if (ticker) {
            ticker.dispose();
          } else {
            restoreCursorAfterTerminate = true;
          }
        }
      } finally {
        framePort.close();
        const terminated = worker.terminate();
        if (restoreCursorAfterTerminate) {
          restoreCursor();
          void terminated.then(restoreCursor);
        }
      }
    },
  };
}

function outputFd(fd: number | undefined): fd is number {
  return fd !== undefined && Number.isInteger(fd) && fd >= 0;
}

export function createLiveTicker(options: LiveTickerOptions): LiveTicker {
  if (outputFd(options.fd)) {
    try {
      return createWorkerTicker({ ...options, fd: options.fd });
    } catch {
      // Some embeddings do not provide worker threads.
    }
  }
  return createInlineTicker(options);
}
