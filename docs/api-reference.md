# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint            | Declaration                             | Surface hash                                                       | Exported symbols |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`            | `./dist/core/pipeline.d.ts`             | `abb2f1fca6d2e21eda1bc1cf72921fee3110f474660834202d223f805300c8d9` |               65 |
| `tubeless/batch`      | `./dist/utilities/batch.d.ts`           | `6b7fe7d6eec6532cc835505517c3481e4290a2a606c2fddf6c80367f5c76c5f5` |                7 |
| `tubeless/node`       | `./dist/node/node.d.ts`                 | `1bf8549ca953a11e7202dbda8013db2a8f1d56286f1618bad929efbbb2efd302` |                3 |
| `tubeless/rate-limit` | `./dist/utilities/rate-limit.d.ts`      | `5cd093bb780a19e44b087b01e2b38e06f07e7233c9920988ba399036e319c368` |                1 |
| `tubeless/retry`      | `./dist/utilities/retry.d.ts`           | `f91f83f8e31e3e629ed90d1b04656110572ea970187a92369f0908cd75ae8f00` |                4 |
| `tubeless/workbench`  | `./dist/workbench/workbench-entry.d.ts` | `494aa61a6345d9a798f2e1f084a69cc7859439237c6614280a96421eb0f17ffd` |                2 |
| `tubeless/testing`    | `./dist/testing/testing.d.ts`           | `9510932b8aec600ecf2bcfdb1a188257dad48a3108087c974689c6e6ec3ad5c9` |                7 |
| `tubeless/tracing`    | `./dist/tracing/tracing.d.ts`           | `c272c955aab09dcd8cc334ffcea3af5cfda420cecc2881a01e3316e3a38801dd` |                3 |

## Symbols

### `tubeless`

- `AnyStep`
- `createSteps`
- `definePipeline`
- `InferSchemaInput`
- `InferSchemaOutput`
- `isPipelineErrorCode`
- `MappedChildProgressOptions`
- `Pipeline`
- `PIPELINE_ERROR_CODES`
- `PIPELINE_MERMAID_DIRECTIONS`
- `PipelineContext`
- `PipelineDefinition`
- `PipelineDefinitionError`
- `PipelineError`
- `PipelineErrorCause`
- `PipelineErrorCode`
- `PipelineErrorKind`
- `PipelineErrorPhase`
- `PipelineExecutionContext`
- `PipelineExecutionError`
- `PipelineFanOutDiagnostics`
- `PipelineFanOutFailure`
- `PipelineHooks`
- `PipelineLogger`
- `PipelineMermaidDirection`
- `PipelineMermaidOptions`
- `PipelinePlan`
- `PipelinePlanStep`
- `PipelineRun`
- `PipelineRunControls`
- `PipelineRunOptions`
- `PipelineRunStatus`
- `PipelineRuntime`
- `PipelineStepCancelledEvent`
- `PipelineStepCancelledReport`
- `PipelineStepCompleteEvent`
- `PipelineStepCompleteReport`
- `PipelineStepContext`
- `PipelineStepFailedEvent`
- `PipelineStepFailedReport`
- `PipelineStepLifecycleStatus`
- `PipelineStepPlannedEvent`
- `PipelineStepProgress`
- `PipelineStepProgressDetail`
- `PipelineStepProgressDetailStatus`
- `PipelineStepProgressEvent`
- `PipelineStepReport`
- `PipelineStepReportStatus`
- `PipelineStepSelectionReason`
- `PipelineStepSkippedEvent`
- `PipelineStepSkippedReport`
- `PipelineStepSkipReason`
- `PipelineStepStartEvent`
- `PipelineStepStatus`
- `PipelineValidationIssue`
- `RemoteStepAdapter`
- `requireOutputs`
- `RUN_MODEL_VERSION`
- `StandardSchemaV1`
- `StandardSchemaV1Issue`
- `StandardSchemaV1Props`
- `StandardSchemaV1Result`
- `Step`
- `StepFactory`
- `StepSkipDecision`

### `tubeless/batch`

- `chunk`
- `ConcurrentSettleResult`
- `ConcurrentWorker`
- `runBatched`
- `runConcurrent`
- `RunConcurrentOptions`
- `runConcurrentSettled`

### `tubeless/node`

- `CheckpointStore`
- `openCheckpoint`
- `withCheckpointedBatch`

### `tubeless/rate-limit`

- `RateLimiter`

### `tubeless/retry`

- `RetryAttemptContext`
- `RetryOperation`
- `RetryOptions`
- `withRetry`

### `tubeless/workbench`

- `definePipelineCommand`
- `definePipelineProject`

### `tubeless/testing`

- `createPipelineTestRuntime`
- `PipelineTestClock`
- `PipelineTestLogEntry`
- `PipelineTestLogLevel`
- `PipelineTestRuntime`
- `PipelineTestRuntimeOptions`
- `PipelineTestSleep`

### `tubeless/tracing`

- `composeTraceExporters`
- `PipelineTraceEvent`
- `PipelineTraceExporter`
