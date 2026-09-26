const UNIT_MILLISECONDS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Resolve a fixed duration to milliseconds; calendar months and years are ambiguous. */
export function cacheDurationMs(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  let milliseconds: number;
  if (typeof value === "number") milliseconds = value;
  else {
    const match =
      typeof value === "string" &&
      value
        .trim()
        .match(
          /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|w|weeks?)$/i
        );
    if (!match) throw new Error('maxAge must be milliseconds or a duration such as "30 days"');
    const unit = match[2]!.toLowerCase();
    const normalizedUnit = unit === "ms" || unit.startsWith("millisecond") ? "ms" : unit[0]!;
    const scale = UNIT_MILLISECONDS[normalizedUnit]!;
    const [whole, fraction = ""] = match[1]!.split(".");
    const divisor = 10n ** BigInt(fraction.length);
    const scaled = BigInt(whole + fraction) * BigInt(scale);
    if (scaled % divisor !== 0n) {
      throw new Error("maxAge must resolve to a nonnegative safe integer number of milliseconds");
    }
    milliseconds = Number(scaled / divisor);
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("maxAge must resolve to a nonnegative safe integer number of milliseconds");
  }
  return milliseconds;
}
