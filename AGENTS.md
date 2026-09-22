# `tubeless` maintainer instructions

- Read [`docs/agent-guide.md`](./docs/agent-guide.md) before changing usage or
  public behavior.
- When generating or modifying pipelines, use the repository-local
  [`tubeless` skill](./skills/tubeless/SKILL.md).
- Preserve the dependency-free runtime and the checked public API boundary.
- Keep executable examples on public package imports; they compile in CI.
- Do not edit `docs/api-reference.md` or `docs/api-report.json` manually. Run
  `bun run api:generate` after intentional public declaration changes.
- Update the recipe index, project manifest, and agent guidance when behavior or
  recommended usage changes.
- The public website lives in `website/` and is not part of the npm package.
  Rebuild it when human-facing docs or recommended usage change.
- Run `make check` from this package directory before handoff.
- Repository CI is defined by `scripts/check-pipeline.ts`; keep its check
  graph, `package.json`, and `.github/workflows/check.yml` aligned.

## API design philosophy

- Keep public APIs simple and clear, with natural, deterministic defaults such as
  running all steps unless explicitly filtered and returning the last logical step's
  output. Infer types and avoid redundant setup.
- Keep internal APIs modular and encapsulated, with explicit ownership and
  validated boundaries. Convenience must never compromise correctness.
- Align types with runtime behavior; test invariants and failure, cancellation,
  dry-run, and concurrency edge cases. Prefer fewer concepts over more knobs.

## Source organization

- Follow [`src/README.md`](./src/README.md) for module ownership and dependency
  direction. Keep tests beside their implementations and preserve public subpaths.
- Keep storage and studio optional; the workbench supplies concrete adapters and
  execution capabilities. Do not introduce reverse runtime dependencies into core.
- Preserve the runtime graph checks in `src/core/pipeline-entry.test.ts` when
  moving modules, including their coverage of transitive and lazy imports.
