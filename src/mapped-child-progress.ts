import type { PipelineStepProgressDetail } from "./pipeline.js";

/** Compatibility alias of the shared progress-detail shape. */
export type MappedChildProgressDetail = PipelineStepProgressDetail;

/**
 * Live state for a `forEachPipeline` fan-out. Domain-agnostic: items can be
 * shards, URLs, files, jobs, or anything else the parent maps over.
 *
 * Runtime-free: only a type-only import of the shared progress detail.
 */
export interface MappedChildProgressSnapshot {
  /** Item key → short status label for currently in-flight children. */
  readonly active: ReadonlyMap<string, string>;
  /** Configured concurrency bound for the fan-out. */
  readonly concurrency: number;
  readonly failedItems: number;
  readonly finishedItems: number;
  readonly itemCount: number;
  /**
   * Maximum selected child steps per item seen so far. This is retained for
   * compatibility with callers that provide uniform plans; exact fan-out
   * totals use `plannedChildSteps` once every item plan is known.
   */
  readonly stepsPerItem: number;
  /** Total selected child steps across the item plans discovered so far. */
  readonly plannedChildSteps?: number;
  /** Number of item plans included in `plannedChildSteps`. */
  readonly plannedItems?: number;
  /** Cumulative terminal child steps across all items. */
  readonly terminalChildSteps: number;
  /** Optional one-off note (e.g. the item that just finished or failed). */
  readonly spotlight?: string;
}

export interface MappedChildProgressUnits {
  completed: number;
  total: number;
}

export interface FormatMappedChildProgressOptions {
  /**
   * Max in-flight item labels embedded in the one-line summary message.
   * Defaults to `0` — prefer `details` rows for multi-line reporters.
   * Set > 0 when a plain/one-line consumer needs samples in `message`.
   */
  sampleLimit?: number;
  /**
   * Max detail rows emitted for multi-line reporters. Defaults to unlimited
   * (all active items). Use a positive cap for very large fan-outs.
   */
  detailLimit?: number;
  /**
   * Plural noun for the mapped work unit in the default message.
   * Defaults to `"items"`. Domain packages pass their own label
   * (`"shards"`, `"images"`, `"editions"`) without custom formatters.
   */
  itemNoun?: string;
}

/**
 * Resolve determinate progress units for a mapped fan-out.
 *
 * When every item plan is known, progress advances on terminal child steps
 * using the exact sum of selected steps across items. The transition preserves
 * the prior item-level completion fraction, rounding up when necessary, so a
 * newly discovered denominator cannot make the reporter move backward. Until
 * then it falls back to item-level accounting. Legacy snapshots without the
 * exact plan fields retain the uniform `stepsPerItem` behavior.
 */
export function mappedChildProgressUnits(
  snapshot: MappedChildProgressSnapshot
): MappedChildProgressUnits {
  if (snapshot.itemCount <= 0) {
    return { completed: 0, total: 0 };
  }
  const plannedItems = snapshot.plannedItems;
  const plannedChildSteps = snapshot.plannedChildSteps;
  if (plannedItems !== undefined && plannedChildSteps !== undefined) {
    if (plannedItems >= snapshot.itemCount && plannedChildSteps > 0) {
      const completedItems = Math.min(
        snapshot.finishedItems + snapshot.failedItems,
        snapshot.itemCount
      );
      const preservedItemProgress =
        completedItems === 0
          ? 0
          : Math.ceil((completedItems * plannedChildSteps) / snapshot.itemCount);
      return {
        completed: Math.min(
          plannedChildSteps,
          Math.max(snapshot.terminalChildSteps, preservedItemProgress)
        ),
        total: plannedChildSteps,
      };
    }
    return {
      completed: Math.min(snapshot.finishedItems + snapshot.failedItems, snapshot.itemCount),
      total: snapshot.itemCount,
    };
  }
  if (snapshot.stepsPerItem > 0) {
    const total = snapshot.itemCount * snapshot.stepsPerItem;
    return {
      completed: Math.min(snapshot.terminalChildSteps, total),
      total,
    };
  }
  return {
    completed: Math.min(snapshot.finishedItems + snapshot.failedItems, snapshot.itemCount),
    total: snapshot.itemCount,
  };
}

/**
 * Default domain-neutral one-line summary for mapped children.
 *
 * Example (no samples):
 * `3/10 items · 4 running (max 8)`
 *
 * Example with `sampleLimit: 2`:
 * `3/10 items · 4 running (max 8) · shard-a/parse · shard-b/write · +2 more`
 */
export function formatMappedChildProgressMessage(
  snapshot: MappedChildProgressSnapshot,
  options: FormatMappedChildProgressOptions = {}
): string {
  const noun = options.itemNoun?.trim() || "items";
  if (snapshot.itemCount <= 0) {
    return `0 ${noun}`;
  }

  const sampleLimit = Math.max(0, Math.floor(options.sampleLimit ?? 0));
  const runningEntries = [...snapshot.active.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const runningSample = runningEntries
    .slice(0, sampleLimit)
    .map(([itemKey, label]) => `${itemKey}/${label}`)
    .join(" · ");
  const overflow =
    sampleLimit > 0 && runningEntries.length > sampleLimit
      ? ` · +${runningEntries.length - sampleLimit} more`
      : "";

  const settled = snapshot.finishedItems + snapshot.failedItems;
  const parts = [
    `${snapshot.finishedItems}/${snapshot.itemCount} ${noun}`,
    snapshot.failedItems > 0 ? `${snapshot.failedItems} failed` : null,
    snapshot.active.size > 0
      ? `${snapshot.active.size} running (max ${snapshot.concurrency})`
      : settled >= snapshot.itemCount
        ? null
        : "starting",
    runningSample ? `${runningSample}${overflow}` : null,
    snapshot.spotlight,
  ].filter((part): part is string => Boolean(part));

  return parts.join(" · ");
}

/**
 * Build sorted detail rows for in-flight mapped children.
 * Stable key order so multi-line UIs do not thrash row positions.
 */
export function mappedChildProgressDetails(
  snapshot: MappedChildProgressSnapshot,
  options: Pick<FormatMappedChildProgressOptions, "detailLimit"> = {}
): MappedChildProgressDetail[] {
  const entries = [...snapshot.active.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const limit =
    options.detailLimit === undefined
      ? entries.length
      : Math.max(0, Math.floor(options.detailLimit));
  const visible = entries.slice(0, limit);
  const details: MappedChildProgressDetail[] = visible.map(([id, label]) => ({
    id,
    label,
    status: "running" as const,
  }));
  if (entries.length > visible.length) {
    details.push({
      id: `+${entries.length - visible.length} more`,
      status: "pending",
    });
  }
  return details;
}

export interface ToMappedChildStepProgressOptions extends FormatMappedChildProgressOptions {
  /**
   * Replace the default message while keeping the same completed/total units.
   * Use this for domain labels without forking the fan-out runner.
   *
   * @example
   * formatMessage: (s) => `${s.finishedItems}/${s.itemCount} images`
   */
  formatMessage?: (
    snapshot: MappedChildProgressSnapshot,
    units: MappedChildProgressUnits
  ) => string;
}

/**
 * Build a progress payload for an opaque mapped-child parent step.
 * Shape matches `PipelineStepProgress` without importing the runtime module.
 *
 * `message` is a one-line summary; `details` lists each in-flight item for
 * multi-line reporters.
 */
export function toMappedChildStepProgress(
  snapshot: MappedChildProgressSnapshot,
  options: ToMappedChildStepProgressOptions = {}
) {
  const units = mappedChildProgressUnits(snapshot);
  const message =
    options.formatMessage?.(snapshot, units) ??
    formatMappedChildProgressMessage(snapshot, {
      itemNoun: options.itemNoun,
      sampleLimit: options.sampleLimit,
    });
  // Empty fan-outs report total 0; otherwise keep total ≥ 1 so renderers can
  // show a determinate bar once work has been scheduled.
  const total =
    snapshot.itemCount === 0
      ? 0
      : Math.max(1, units.total === 0 ? snapshot.itemCount : units.total);
  return {
    completed: units.completed,
    total,
    message,
    details: mappedChildProgressDetails(snapshot, {
      detailLimit: options.detailLimit,
    }),
  };
}
