# Add `fromRemote` to the README pattern table

GitHub: [chetmancini/tubeless#48](https://github.com/chetmancini/tubeless/issues/48)

## Problem

[`README.md`](../../../README.md) is the package entry point. Its "Choose the
right pattern" table has no row for `fromRemote`. A reader who starts there
cannot reach [`examples/remote-steps.ts`](../../../examples/remote-steps.ts),
even though remote steps already have a composition guide, two recipe-index
rows, agent-guide rules, and a compiled example.

## Goal

Make remote steps discoverable from the README with one table row. Do not
change runtime behavior, the public API, or the rest of the learning surface.

## Change

In the README pattern table, insert this row immediately after "Reuse a
pipeline inside another" (child pipeline) and before "Run one child pipeline
for many items" (fan-out). That matches recipe-index order.

```
| Run a step on another engine | [Remote steps](../../../examples/remote-steps.ts) |
```

In `README.md` itself the href stays package-root relative:
`./examples/remote-steps.ts`. The path above is only so this spec’s Markdown
link resolves from `docs/superpowers/specs/`.

The table row is one line. README is 115 lines today; after the insert it is 116. The learning-surface cap in
[`scripts/validate-learning-surface.mjs`](../../../scripts/validate-learning-surface.mjs)
stays at 120. Do not trim another row. Do not raise the cap.

## Out of scope

- A second README row for host-embedding (Temporal/Lambda/`runOrThrow` with
  `runId` / `parentRunId`). That composition is already documented; this issue
  is `fromRemote` discoverability.
- Recipe index, agent guide, concepts, comparison, website, and
  `examples/remote-steps.ts`. They already cover remote steps.
- Validator budget comments or cap changes.

## Success

- The README table links to `examples/remote-steps.ts` with the copy above.
- `bun run docs:check` passes (line budget and link check).
- `make check` is green.
