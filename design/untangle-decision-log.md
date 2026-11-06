# Untangle decision log

Scope: the package runtime, optional integrations, executable tooling, tests, and
website. Preserve public behavior and the dependency-free runtime. Comments and
tests cleanup are included. The clean baseline passed all nine `make check`
checks before implementation.

## Decisions recorded before implementation

1. **Carry validated graph inputs into compilation.** Definition validation,
   graph compilation, and pipeline compilation independently compute order,
   implicit targets, and required-finalizer metadata. Compilation also assumes
   validation already proved a second sort succeeds. Let validation produce the
   compilation inputs and consume them once.
2. **Own inherited child context in one private builder.** Direct, single, and
   mapped child invocation in `core/child-execution.ts` each reconstruct runtime,
   parent identity, tracing, and execution scope. Keep their distinct hooks and
   item identities at the call sites.
3. **Own artifact adaptation once.** Load/save builders in
   `core/pipeline-step-builders.ts` duplicate invocation, artifact recording,
   value extraction, and dry-run wrapping. Share that sequence while retaining
   read/write defaults explicitly.
4. **Give workspace constraints and text clipping explicit owners.** Tool
   schemas, local adapters, guidance reads, and prompt validation repeat the same
   bounds. Extend `agent/default-tool-limits.ts`, keeping coincidentally equal
   bounds distinct. Bash imports filesystem implementation solely for
   `clippedText`; move that pure operation out of filesystem ownership.
5. **Give live and restored agent limits one validation vocabulary.**
   `agent/execution-scope.ts` and `checkpoint-format.ts` independently enumerate
   supported limits and which permit zero. Share those rules while retaining
   boundary-specific errors.
6. **Declare CLI built-ins once.** `cli/cli-pipeline-command.ts` repeats builtin
   keys, flag names, domain omissions, and schema declarations. Derive conflict
   checks and domain omission from the schemas, preserving reserved target names
   even when a pipeline exposes no targets. Completion also repeats an existing
   completion-value type.
7. **Own Cloud request and host-failure contracts together.** Cloud input size
   is independently enforced in the workbench client and run input loader.
   Cloudflare run and Studio independently spell the same host-termination
   message. Remove the single-use reconciliation wrapper. Keep verified scaffold
   dependency versions intentional and check their documented command against
   the scaffold instead of independently pinning it in tests.
8. **Give recorded definition resources one owner.** Studio definition history
   and pipeline views repeat identity, loading, and legacy-versus-identified
   revision rules. Share the resource hook and use a feature-neutral generic
   resource error.
9. **Make child ordering a shared Studio rule.** Server child pagination and
   browser graph truncation each sort by iteration then start time. Use one pure
   comparator without coupling pagination to geometry.
10. **Remove the internal reporter barrel.** `reporter/reporter-entry.ts` only
    reexports one implementation and type to its single CLI consumer.
11. **Own file-worker argument compatibility once.** Reporter, worker adapter,
    and code-mode executor independently remove `--input-type` and its argument.
    Use a pure utility with explicit argv input; do not widen runtime dependency
    permissions or generalize distinct worker URL locations.
12. **Declare Studio build artifacts with their generator.** The generator and
    watcher independently spell output paths; neither startup presence checks
    nor generated-output verification includes the Cloudflare declaration file.
    Share paths through the generator and include every generated artifact.
13. **Remove dead website link-check branches.** `normalizePathname` always
    returns a string, but its caller handles undefined; trailing slashes do not
    affect filesystem resolution. Remove that unnecessary normalization layer.
14. **Make tests observe behavior, last.** Replace the atomic-write filename and
    option assertion with a real collision; replace Studio private hook-key
    assertions with definition selection/refresh behavior; remove generated
    bundle-copy pins in the page test. Website metadata tests pin editorial copy
    rather than consistency between rendered metadata; check semantic presence
    and agreement instead. Remove duplicate built-link failure cases.
15. **Remove confirmed restatement comments.** Review the identified private
    helper and inline comments across the touched subsystems. Preserve public
    contract documentation, safety evidence, and external constraints.
16. **Compare rendered HTML values rather than their serialization.** Independent
    review found that the new metadata consistency assertions compare escaped
    text with attribute serialization; valid apostrophes or angle brackets could
    fail. Share entity decoding with the link checker and verify semantic values.

## Cases deliberately retained

- External versus compiled child pipelines, dry-run/cache inheritance, scope
  transport, iteration relations, cancellation/draining, and bounded progress.
- Provider and MCP wire differences, strict schema subsets, interrupted unsafe
  calls, checkpoint validation and recovery, and code-mode isolation/deadlines.
- SQLite runtime/readonly differences, legacy trace decoding, parent-cycle
  recovery, bounded history retention, stale requests, and transient missing runs.
- Terminal worker fallback, output locks, acknowledgements, bounded shutdown,
  cursor restoration, and source-versus-built worker URL resolution.
- Atomic filesystem replacement, symlink/permission defenses, cleanup preserving
  original failures, watch portability, and explicit deployment compatibility pins.
- Authentication/routing order, Host/Origin checks, raw path validation, and CSP.

These branches encode requirements; removing them would change supported behavior.

## Validation and repeat audit

All sixteen decisions are implemented. Subsystem audits and follow-up reviews of
core/project/utilities, agents, CLI/workbench/Cloudflare, and
Studio/storage/reporting found no further structural changes worth making.
Independent review of the tooling and website identified decision 16, which was
implemented and regression-tested before final verification.

- `make check` passes all nine quality gates, including 225 test files,
  3,125 passing tests and three platform-dependent skips, emitted runtime graph
  checks, example/type probes, lint, formatting, unused-code analysis, generated
  assets/API checks, documentation checks and packed-artifact execution.
- The website build passes its 21 tests and checks 22 Markdown documents and
  31 sitemap pages, including analytics-enabled/disabled builds and broken links.
- API artifacts were regenerated with `bun run api:generate`. Export lists are
  unchanged across all 16 public entrypoints; internal declaration hashes and
  source links changed as expected.
- The first integrated gate exposed two exact import allowlists that needed the
  shared Studio comparator. Both were updated without allowing execution, UI,
  transport or storage adapters into the protected graphs.
- No package dependencies, public subpaths, deployment versions or intended
  execution behavior changed. No source/test changes remain deferred.
