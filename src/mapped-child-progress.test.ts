import { describe, expect, it } from "vitest";
import {
  formatMappedChildProgressMessage,
  mappedChildProgressDetails,
  mappedChildProgressUnits,
  toMappedChildStepProgress,
  type MappedChildProgressSnapshot,
} from "./mapped-child-progress.js";

function snapshot(
  overrides: Partial<MappedChildProgressSnapshot> = {}
): MappedChildProgressSnapshot {
  return {
    active: new Map(),
    concurrency: 4,
    failedItems: 0,
    finishedItems: 0,
    itemCount: 10,
    stepsPerItem: 0,
    terminalChildSteps: 0,
    ...overrides,
  };
}

describe("mappedChildProgressUnits", () => {
  it("uses item counts before child plans are known", () => {
    expect(
      mappedChildProgressUnits(
        snapshot({ finishedItems: 2, failedItems: 1, itemCount: 10, stepsPerItem: 0 })
      )
    ).toEqual({ completed: 3, total: 10 });
  });

  it("switches to step-granular units once stepsPerItem is known", () => {
    expect(
      mappedChildProgressUnits(
        snapshot({
          finishedItems: 1,
          itemCount: 4,
          stepsPerItem: 5,
          terminalChildSteps: 7,
        })
      )
    ).toEqual({ completed: 7, total: 20 });
  });

  it("uses the exact sum when item plans have different selected step counts", () => {
    expect(
      mappedChildProgressUnits(
        snapshot({
          itemCount: 2,
          plannedChildSteps: 3,
          plannedItems: 2,
          stepsPerItem: 2,
          terminalChildSteps: 3,
        })
      )
    ).toEqual({ completed: 3, total: 3 });
  });

  it("preserves item-level completion when switching to an exact mixed-plan total", () => {
    expect(
      mappedChildProgressUnits(
        snapshot({
          finishedItems: 1,
          itemCount: 2,
          plannedChildSteps: 5,
          plannedItems: 2,
          stepsPerItem: 4,
          terminalChildSteps: 2,
        })
      )
    ).toEqual({ completed: 3, total: 5 });
  });

  it("keeps item-level units while only some item plans are known", () => {
    expect(
      mappedChildProgressUnits(
        snapshot({
          finishedItems: 1,
          itemCount: 2,
          plannedChildSteps: 1,
          plannedItems: 1,
          stepsPerItem: 5,
          terminalChildSteps: 1,
        })
      )
    ).toEqual({ completed: 1, total: 2 });
  });

  it("handles an empty fan-out", () => {
    expect(mappedChildProgressUnits(snapshot({ itemCount: 0 }))).toEqual({
      completed: 0,
      total: 0,
    });
  });
});

describe("formatMappedChildProgressMessage", () => {
  it("keeps the one-line summary free of active samples by default", () => {
    const message = formatMappedChildProgressMessage(
      snapshot({
        active: new Map([
          ["shard-a", "parse"],
          ["shard-b", "write"],
        ]),
        concurrency: 8,
        finishedItems: 3,
        itemCount: 10,
      })
    );
    expect(message).toBe("3/10 items · 2 running (max 8)");
    expect(message).not.toContain("shard-a");
  });

  it("can still embed samples when sampleLimit is set", () => {
    const message = formatMappedChildProgressMessage(
      snapshot({
        active: new Map([
          ["shard-a", "parse"],
          ["shard-b", "write"],
          ["shard-c", "upload"],
          ["shard-d", "finalize"],
        ]),
        concurrency: 8,
        finishedItems: 3,
        itemCount: 10,
      }),
      { sampleLimit: 2 }
    );
    expect(message).toBe(
      "3/10 items · 4 running (max 8) · shard-a/parse · shard-b/write · +2 more"
    );
  });

  it("accepts a domain noun without a custom formatter", () => {
    expect(
      formatMappedChildProgressMessage(
        snapshot({ finishedItems: 2, itemCount: 5, active: new Map([["img-1", "encode"]]) }),
        { itemNoun: "images" }
      )
    ).toContain("2/5 images");
  });

  it("reports zero items with the configured noun", () => {
    expect(formatMappedChildProgressMessage(snapshot({ itemCount: 0 }), { itemNoun: "jobs" })).toBe(
      "0 jobs"
    );
  });
});

describe("mappedChildProgressDetails", () => {
  it("lists active children sorted by key as running detail rows", () => {
    expect(
      mappedChildProgressDetails(
        snapshot({
          active: new Map([
            ["zeta", "write"],
            ["alpha", "parse"],
          ]),
        })
      )
    ).toEqual([
      { id: "alpha", label: "parse", status: "running" },
      { id: "zeta", label: "write", status: "running" },
    ]);
  });

  it("caps detail rows and reports overflow", () => {
    expect(
      mappedChildProgressDetails(
        snapshot({
          active: new Map([
            ["a", "1"],
            ["b", "2"],
            ["c", "3"],
          ]),
        }),
        { detailLimit: 2 }
      )
    ).toEqual([
      { id: "a", label: "1", status: "running" },
      { id: "b", label: "2", status: "running" },
      { id: "+1 more", status: "pending" },
    ]);
  });
});

describe("toMappedChildStepProgress", () => {
  it("builds a PipelineStepProgress-compatible payload with details", () => {
    expect(
      toMappedChildStepProgress(
        snapshot({
          finishedItems: 1,
          itemCount: 2,
          stepsPerItem: 3,
          terminalChildSteps: 4,
          active: new Map([["a", "run"]]),
        })
      )
    ).toEqual({
      completed: 4,
      total: 6,
      message: "1/2 items · 1 running (max 4)",
      details: [{ id: "a", label: "run", status: "running" }],
    });
  });

  it("lets callers fully customize the message", () => {
    const progress = toMappedChildStepProgress(
      snapshot({ finishedItems: 2, itemCount: 5, stepsPerItem: 1, terminalChildSteps: 2 }),
      {
        formatMessage: (state, units) =>
          `custom ${state.finishedItems}/${state.itemCount} (units ${units.completed}/${units.total})`,
      }
    );
    expect(progress.message).toBe("custom 2/5 (units 2/5)");
  });
});
