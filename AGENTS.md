# `tubeless` maintainer instructions

- Read [`docs/agent-guide.md`](./docs/agent-guide.md) before changing usage or
  public behavior.
- Preserve the dependency-free runtime and the checked public API boundary.
- Keep executable examples on public package imports; they compile in CI.
- Do not edit `docs/api-reference.md` or `docs/api-report.json` manually. Run
  `bun run api:generate` after intentional public declaration changes.
- Update the recipe index and agent guidance when behavior or recommended usage
  changes.
- Run `make check` from this package directory before handoff.
