/** Watch for the first terminal signal, then restore default signal handling. */
export function onFirstProcessSignal<const TSignal extends NodeJS.Signals>(
  signals: readonly TSignal[],
  onFirst: (signal: TSignal) => void
): () => void {
  let handled = false;
  const removeAll = (): void => {
    for (const { signal, listener } of listeners) {
      process.removeListener(signal, listener);
    }
  };
  const listeners = signals.map((signal) => {
    const listener = (): void => {
      if (handled) return;
      handled = true;
      removeAll();
      onFirst(signal);
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  return removeAll;
}

const TERMINAL_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type TerminalSignal = (typeof TERMINAL_SIGNALS)[number];

export function manageCliSignal(
  signal?: AbortSignal,
  onInterrupt?: (signal: TerminalSignal) => void
) {
  if (signal) return { signal, cleanup() {} };
  const controller = new AbortController();
  const cleanup = onFirstProcessSignal(TERMINAL_SIGNALS, (signal) => {
    onInterrupt?.(signal);
    controller.abort();
  });
  return { signal: controller.signal, cleanup };
}
