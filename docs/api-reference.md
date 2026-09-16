# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint              | Declaration                             | Surface hash                                                       | Exported symbols |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`              | `./dist/core/pipeline.d.ts`             | `4aa6f7a98d8da2e447fcdb10ed0ce464b437d07e8b4b210cab36874a91aa409f` |               65 |
| `tubeless/batch`        | `./dist/utilities/batch.d.ts`           | `6b7fe7d6eec6532cc835505517c3481e4290a2a606c2fddf6c80367f5c76c5f5` |                7 |
| `tubeless/node`         | `./dist/node/node.d.ts`                 | `1bf8549ca953a11e7202dbda8013db2a8f1d56286f1618bad929efbbb2efd302` |                3 |
| `tubeless/rate-limit`   | `./dist/utilities/rate-limit.d.ts`      | `5cd093bb780a19e44b087b01e2b38e06f07e7233c9920988ba399036e319c368` |                1 |
| `tubeless/retry`        | `./dist/utilities/retry.d.ts`           | `f91f83f8e31e3e629ed90d1b04656110572ea970187a92369f0908cd75ae8f00` |                4 |
| `tubeless/workbench`    | `./dist/workbench/workbench-entry.d.ts` | `9712ef77fb78259261f0bfff0443b2f489bf0d6d47fa48e1d996eefce8a08ff6` |                2 |
| `tubeless/testing`      | `./dist/testing/testing.d.ts`           | `b4422e19dd0761e2bc39fb64332809c3f7e0098d6439423b4ce8009ccc582843` |                7 |
| `tubeless/tracing`      | `./dist/tracing/tracing.d.ts`           | `ce64111cd6b3798c358cb608a7c376dfe1561a3dbe9c0155dda14c63a8efbb5e` |               25 |
| `tubeless/tracing/json` | `./dist/tracing/tracing-json.d.ts`      | `6f737d6faff6b3c0ea3fdf720d7eb7337f8e2d3cded6abb444f62ec9d0e72bb9` |                2 |
| `tubeless/tracing/otel` | `./dist/tracing/tracing-otel.d.ts`      | `53fb9c215a171da414a32ba7b5b0fea99a2db412f6adebffc7807cd37d90e218` |                4 |

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
- `PipelineCompletedTraceEvent`
- `PipelineFinalizeCompletedTraceEvent`
- `PipelineFinalizeFailedTraceEvent`
- `PipelineFinalizeStartedTraceEvent`
- `PipelineLogTraceEvent`
- `PipelineStartedTraceEvent`
- `PipelineTraceAttributes`
- `PipelineTraceAttributeValue`
- `PipelineTraceContext`
- `PipelineTraceError`
- `PipelineTraceEvent`
- `PipelineTraceEventName`
- `PipelineTraceExporter`
- `PipelineTraceNestedPipeline`
- `PipelineTraceProgress`
- `PipelineTraceRemote`
- `PipelineTracingOptions`
- `StepAttemptedTraceEvent`
- `StepCancelledTraceEvent`
- `StepCompletedTraceEvent`
- `StepFailedTraceEvent`
- `StepPlannedTraceEvent`
- `StepRunningTraceEvent`
- `StepSkippedTraceEvent`

### `tubeless/tracing/json`

- `createJsonTraceExporter`
- `JsonTraceExporterOptions`

### `tubeless/tracing/otel`

- `createOpenTelemetryTraceExporter`
- `OpenTelemetryLikeSpan`
- `OpenTelemetryLikeTracer`
- `OpenTelemetryTraceExporterOptions`
