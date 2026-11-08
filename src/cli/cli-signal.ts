/** Watch for the first terminal signal, then restore default signal handling. */
export function onFirstProcessSignal(
  signals: readonly NodeJS.Signals[],
  onFirst: (signal: NodeJS.Signals) => void
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
