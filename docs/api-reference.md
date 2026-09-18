# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint            | Declaration                        | Surface hash                                                       | Exported symbols |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`            | `./dist/core/pipeline.d.ts`        | `ab59692714bcb5626e79a5ece08726d2893b0145ae4e57b073034b449cda054e` |               64 |
| `tubeless/cli`        | `./dist/cli/cli.d.ts`              | `9c838d29d7e419c7a80b5792f8a356508e360100750a776e6804c53a8b134b13` |               33 |
| `tubeless/batch`      | `./dist/utilities/batch.d.ts`      | `6b7fe7d6eec6532cc835505517c3481e4290a2a606c2fddf6c80367f5c76c5f5` |                7 |
| `tubeless/node`       | `./dist/node/node.d.ts`            | `06411eb43b8d1b5aca5d51d70e68553cb9065447b250c29382e6036ad9eac52c` |                8 |
| `tubeless/rate-limit` | `./dist/utilities/rate-limit.d.ts` | `5cd093bb780a19e44b087b01e2b38e06f07e7233c9920988ba399036e319c368` |                1 |
| `tubeless/retry`      | `./dist/utilities/retry.d.ts`      | `f91f83f8e31e3e629ed90d1b04656110572ea970187a92369f0908cd75ae8f00` |                4 |
| `tubeless/project`    | `./dist/project/project.d.ts`      | `04e7ac5772c7180223aa78ee6313c662f46bb9237402fa6de1d80a5307383ac9` |                8 |
| `tubeless/testing`    | `./dist/testing/testing.d.ts`      | `7b9c5e9f28ea337f6f7d41c760acd3ab78203301dc4ce1b42b332b0ffac3769f` |                7 |
| `tubeless/tracing`    | `./dist/tracing/tracing.d.ts`      | `c272c955aab09dcd8cc334ffcea3af5cfda420cecc2881a01e3316e3a38801dd` |                3 |

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

### `tubeless/cli`

- `CliBooleanParam`
- `CliCheckpointConfig`
- `CliCommand`
- `CliCommandConfig`
- `CliCommandDescriptor`
- `CliContext`
- `CliHelpRequested`
- `CliNumberParam`
- `CliParam`
- `CliParameterDescriptor`
- `CliParams`
- `CliParamsSchema`
- `CliParamType`
- `CliParseResult`
- `CliPathParam`
- `CliStringParam`
- `CliValidationError`
- `defineCommand`
- `definePipelineCommand`
- `DefinePipelineCommandConfig`
- `PipelineCliParseResult`
- `PipelineCliValues`
- `PipelineCommand`
- `PipelineCommandHookConfig`
- `PipelineCommandHookContext`
- `PipelineCommandHookSets`
- `PipelineReporterConfig`
- `PipelineReporterMode`
- `ReporterColorMode`
- `ReporterOutput`
- `ReporterSymbolMode`
- `ReporterTerminalCapabilities`
- `RunReporterConfig`

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
- `definePaths`
- `openCheckpoint`
- `readJson`
- `requireEnv`
- `resetDir`
- `withCheckpointedBatch`
- `writeJson`

### `tubeless/rate-limit`

- `RateLimiter`

### `tubeless/retry`

- `RetryAttemptContext`
- `RetryOperation`
- `RetryOptions`
- `withRetry`

### `tubeless/project`

- `compilePipelineDocument`
- `definePipelineProject`
- `PipelineDocumentError`
- `PipelineDocumentRegistry`
- `PipelineProjectCommandModule`
- `PipelineProjectManifest`
- `PipelineProjectManifestInput`
- `validatePipelineDocument`

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
