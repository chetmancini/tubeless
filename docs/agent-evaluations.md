# Agent evaluations

The cases in [`../evals/agent-cases.json`](../evals/agent-cases.json) test whether
an agent can discover and apply the package's important patterns. Prompts and
provider invocation remain provider-neutral.

## Generate a submission

1. Start a clean agent session with access to the repository.
2. Tell it to use the repository-local `tubeless` skill
   ([`skills/tubeless/SKILL.md`](../skills/tubeless/SKILL.md)).
3. Give it exactly one case's `prompt`; do not reveal the expectations.
4. Have it write into a disposable submission directory outside production
   paths.

The directory must contain a regular, non-symlink `solution.ts`. Additional
`.ts`, `.tsx`, `.mts`, or `.cts` helper files are compiled with it. An optional
`assessment.json` records operator scoring.

## Compile a submission

```sh
bun run eval:agent -- \
  --case sequential-import \
  --submission .context/agent-eval/sequential-import \
  --report .context/agent-eval/sequential-import-report.json
```

The evaluator builds and packs the current package, installs that artifact into
a disposable project, compiles every submission source against its public
declarations, emits a stable JSON report, and deletes the project. Pass
`--package` to reuse an existing tarball.

The evaluator never executes submission code. Run behavioral tests only in an
external disposable sandbox with its own process, filesystem, and network
containment.

Exit status is `0` when compilation passes and no assessed expectation fails,
`1` for a compile or assessed expectation failure, and `2` for invalid runner
configuration.

## Score semantic expectations

Compilation cannot decide whether a design materially demonstrates an
expectation. An operator may add `assessment.json` without changing the
generated solution:

```json
{
  "schemaVersion": 1,
  "caseId": "sequential-import",
  "expectations": [
    {
      "category": "mustDemonstrate",
      "expectation": "typed options",
      "status": "pass",
      "evidence": "ImportOptions types context.options.lines."
    }
  ]
}
```

Categories and expectation text must exactly match the selected case. Partial
assessments are valid; remaining entries stay `unscored`.

The report contains normalized compiler diagnostics, installed package identity,
submission file names, every semantic expectation in case order,
`mechanicalStatus`, `assessmentStatus`, and the combined `ok` value.

`make check` runs four representative fixtures: a valid assessed
pipeline, compiler-rejected invented API usage, artifact-specific declarations,
and a multi-file TSX submission. It also compiles every `learningSurfaceGate`
case's assessed answer under [`evals/answers/`](../evals/answers) and fails when
compilation or any assessed expectation fails. The evaluator still does not
execute submission code.

## Passing standard

- The result typechecks using public package entrypoints.
- Every `mustDemonstrate` item is materially present, not merely mentioned.
- No `mustAvoid` behavior appears.
- The solution uses the smallest fitting primitive and preserves dry-run and
  cancellation safety.
- The agent finds the relevant recipe without reading executor implementation.

The simple, safety-sensitive, fan-out, and CLI cases are `learningSurfaceGate`
cases. Their answers run on every `make check`. Re-run those four against a
fresh agent when changing the learning surface, and run all cases before a
public release or declaration API redesign.
