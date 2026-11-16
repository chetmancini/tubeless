# Paired O2/C4 fixtures

`vitest-failure-v1.json` was produced by Vitest 5.1.0 running the deliberately
failing `fixtures/diagnostics/vitest/failure.spec.ts`, then normalized by
`vitestCheckReport`. Paths are rooted at `/fixture`; recorded timings are sample
observations, not test expectations. `framework-failure-v3.json` contains a real
pipeline failure and its existing trace-codec round trip, with the same path
normalization. They have identical copies in Cloud's `tests/fixtures/diagnostics`.

These fixtures establish local format/consumer agreement. They do not establish
package publication, a Cloud dependency upgrade, native repository report
collection or production deployment. See [the contract](../../docs/structured-diagnostics.md).
