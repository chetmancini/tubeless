# `tubeless` maintainer instructions

- Read [`docs/agent-guide.md`](./docs/agent-guide.md) before changing usage or
  public behavior.
- When generating or modifying pipelines, use the repository-local
  [`tubeless` skill](./skills/tubeless/SKILL.md).
- Preserve the dependency-free runtime and the checked public API boundary.
- Keep executable examples on public package imports; they compile in CI.
- Do not edit `docs/api-reference.md` or `docs/api-report.json` manually. Run
  `bun run api:generate` after intentional public declaration changes.
- Update the recipe index, project catalog, and agent guidance when behavior or
  recommended usage changes.
- The public website lives in `website/` and is not part of the npm package.
  Rebuild it when human-facing docs or recommended usage change.
- Run `make check` from this package directory before handoff.
