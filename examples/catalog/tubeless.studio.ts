import { definePipelineStudio } from "tubeless/workbench/studio";

// Recorded studio history keeps last reportProgress details and nestedPipeline
// labels from these commands. Use --store when launching so that structure
// survives after the live TTY closes.

/** Checked-in catalog. Studio can cancel one live launch from the running detail pane without stopping the server. */
export default definePipelineStudio({
  cwd: ".",
  commands: [
    { file: "./scripts/import.ts", export: "ImportCommand", name: "Import rows" },
    { file: "./scripts/publish.ts", export: "PublishCommand", name: "Publish artifact" },
  ],
});

⚠ 1 unresolved conflict detected
- ours = HEAD
- theirs = 034977c (Limit Cancel run to live launches and document it)
- base = parent of 034977c (Limit Cancel run to live launches and document it)
NOTICE: Inspect a block by reading `conflict://<N>` (add `/ours` / `/theirs` / `/base` to render a single side). Resolve with `write({ path: "conflict://<N>", content })`, or bulk-resolve every registered conflict with `write({ path: "conflict://*", content })`. Writes replace ONLY the marker block (markers + all sides) — never repeat the lines before/after it; they stay in place.
`content` shorthand: a line that is exactly `@ours` / `@theirs` / `@base` / `@both` expands to that recorded section. `@both` is ours-then-theirs with no separator — only for additive conflicts where each side adds something different; NEVER for competing edits of the same lines (pick a side or write the combined text). Lines that are not a token pass through verbatim, so `"// keep both\n@ours\n@theirs"` literally writes the comment, then ours, then theirs.
Per-id bulk: `write({ path: "conflict://*", content: "1: @ours\n2: @theirs\n…" })` resolves each listed id with that side in ONE call — the cheapest way through many pick-one conflicts; unlisted ids stay registered.
Resolve each block faithfully: keep one side (`@ours`/`@theirs`), or combine them when both intents apply — never invent content beyond the recorded sides, and never stack both sides of competing edits. Resolve several conflicts in a single turn by issuing multiple `write` calls at once; ids stay valid as earlier blocks are resolved.

──── #2  L3-11 ────
<<< ours
// Recorded studio history keeps last reportProgress details and nestedPipeline
// labels from these commands. Use --store when launching so that structure
// survives after the live TTY closes.

=== base
(empty)
>>> theirs
/** Checked-in catalog. Studio can cancel one live launch from the running detail pane without stopping the server. */