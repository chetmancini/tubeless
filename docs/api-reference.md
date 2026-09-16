# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                   | Declaration                               | Surface hash                                                       | Exported symbols |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                   | `./dist/core/pipeline.d.ts`               | `ec7304d164d54aa8709034ee29bebd2ce80a0260395c7450e5e4a7d251a548e1` |               77 |
| `tubeless/batch`             | `./dist/utilities/batch.d.ts`             | `6b7fe7d6eec6532cc835505517c3481e4290a2a606c2fddf6c80367f5c76c5f5` |                7 |
| `tubeless/cli`               | `./dist/cli/cli.d.ts`                     | `e3f9bab0a7af0bba5a9d22a33376b41fbad9af32e61817895805659be48000ff` |               28 |
| `tubeless/node`              | `./dist/node/node.d.ts`                   | `1bf8549ca953a11e7202dbda8013db2a8f1d56286f1618bad929efbbb2efd302` |                3 |
| `tubeless/rate-limit`        | `./dist/utilities/rate-limit.d.ts`        | `5cd093bb780a19e44b087b01e2b38e06f07e7233c9920988ba399036e319c368` |                1 |
| `tubeless/render`            | `./dist/render/render.d.ts`               | `355ea6c412c0ae5171a44f26cda7e70e8a624d7644d4d971572fd9c393379ffa` |                6 |
| `tubeless/reporter`          | `./dist/reporter/reporter-entry.d.ts`     | `dc042a584729544dcd141f9110b15668b69259b1e6bedbd4d12ab18292f7bde1` |               13 |
| `tubeless/retry`             | `./dist/utilities/retry.d.ts`             | `f91f83f8e31e3e629ed90d1b04656110572ea970187a92369f0908cd75ae8f00` |                4 |
| `tubeless/run-store`         | `./dist/run-store/run-store.d.ts`         | `b3325042064bdcfbcbba38d30daf90235d34b7282a5e115cb91a2c221d110315` |               18 |
| `tubeless/run-store/sqlite`  | `./dist/run-store/run-store-sqlite.d.ts`  | `a871eef2ed9a76b2af5a8bc8e049e0d12f7846cdf185bc9fc2d9983b14448b22` |                3 |
| `tubeless/run-store/ndjson`  | `./dist/run-store/run-store-ndjson.d.ts`  | `2f590dee345d035f0e73850c0671e95f18418ced6fcb448e850970205a6ffadc` |                3 |
| `tubeless/workbench/project` | `./dist/workbench/workbench-project.d.ts` | `eac0931b2968d98c1b7d41503c1ea61477a2685e8cfebd22863255fce67085a7` |                6 |
| `tubeless/run-store/ui`      | `./dist/studio/run-store-ui.d.ts`         | `05037eb354ba8a560eee297fdb4efe1e127f7edc5cf3f9870115867ee47e7fc5` |                9 |
| `tubeless/testing`           | `./dist/testing/testing.d.ts`             | `47d5ce405bfa9bf639057ba365358f233b82c8afc88a86d28d52c66121e1789c` |                7 |
| `tubeless/tracing`           | `./dist/tracing/tracing.d.ts`             | `38b5275a9467ddc8cc2fa407123af3379b4b0cc439bdda27070af1f8c6850cfa` |               25 |
| `tubeless/tracing/json`      | `./dist/tracing/tracing-json.d.ts`        | `3a147cf9c82418e73394cd7ab4b00da05167b8f43c1771f3011acfcf72e58605` |                2 |
| `tubeless/tracing/otel`      | `./dist/tracing/tracing-otel.d.ts`        | `531c717d638af1b778b8b38517c009ce65f968449737a8ef0985ba470ad23f06` |                4 |

## Symbols

### `tubeless`

- `AnyStep`
- `createRunId`
- `createSteps`
- `defaultPipelineContext`
- `definePipeline`
- `formatMappedChildProgressMessage`
- `FormatMappedChildProgressOptions`
- `InferSchemaInput`
- `InferSchemaOutput`
- `isPipelineErrorCode`
- `MappedChildProgressDetail`
- `mappedChildProgressDetails`
- `MappedChildProgressOptions`
- `MappedChildProgressSnapshot`
- `mappedChildProgressUnits`
- `MappedChildProgressUnits`
- `Pipeline`
- `PIPELINE_ERROR_CODES`
- `PIPELINE_FINALIZE_STEP_ID`
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
- `toMappedChildStepProgress`
- `ToMappedChildStepProgressOptions`

### `tubeless/batch`

- `chunk`
- `ConcurrentSettleResult`
- `ConcurrentWorker`
- `runBatched`
- `runConcurrent`
- `RunConcurrentOptions`
- `runConcurrentSettled`

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
- `PipelineCliBuiltins`
- `PipelineCliParseResult`
- `PipelineCliValues`
- `PipelineCommand`
- `PipelineCommandHookConfig`
- `PipelineCommandHookContext`
- `PipelineCommandHookSets`
- `TUBELESS_WORKBENCH_EXIT_CODE`

### `tubeless/node`

- `CheckpointStore`
- `openCheckpoint`
- `withCheckpointedBatch`

### `tubeless/rate-limit`

- `RateLimiter`

### `tubeless/render`

- `PipelineHumanRenderOptions`
- `PipelineJsonRenderOptions`
- `PipelinePlanRenderOptions`
- `PipelineRenderOptions`
- `renderPipelineError`
- `renderPipelinePlan`

### `tubeless/reporter`

- `createPipelineReporter`
- `createRunReporter`
- `PipelineReporterConfig`
- `PipelineReporterController`
- `PipelineReporterMode`
- `PipelineReporterOptions`
- `ReporterColorMode`
- `ReporterOutput`
- `ReporterSymbolMode`
- `ReporterTerminalCapabilities`
- `ResolvedPipelineReporterMode`
- `RunReporterConfig`
- `RunReporterOptions`

### `tubeless/retry`

- `RetryAttemptContext`
- `RetryOperation`
- `RetryOptions`
- `withRetry`

### `tubeless/run-store`

- `createPipelineRunProjector`
- `PipelineRunEventQuery`
- `PipelineRunEventReader`
- `PipelineRunEventStore`
- `PipelineRunProjector`
- `PipelineRunStoreSnapshot`
- `projectPipelineRun`
- `projectPipelineRunStore`
- `StoredNestedPipeline`
- `StoredPipelineAttempt`
- `StoredPipelineDefinition`
- `StoredPipelineDefinitionStep`
- `StoredPipelineEvent`
- `StoredPipelineLog`
- `StoredPipelineRun`
- `StoredPipelineRunStatus`
- `StoredPipelineStep`
- `StoredRemote`

### `tubeless/run-store/sqlite`

- `openSqlitePipelineRunStore`
- `OpenSqlitePipelineRunStoreOptions`
- `SqlitePipelineRunStore`

### `tubeless/run-store/ndjson`

- `NdjsonPipelineRunStore`
- `openNdjsonPipelineRunStore`
- `OpenNdjsonPipelineRunStoreOptions`

### `tubeless/workbench/project`

- `definePipelineProject`
- `isPipelineProjectManifest`
- `PIPELINE_PROJECT_MANIFEST_VERSION`
- `PipelineProjectCommandModule`
- `PipelineProjectManifest`
- `PipelineProjectManifestInput`

### `tubeless/run-store/ui`

- `PipelineRunStudioCancelResult`
- `PipelineRunStudioCommand`
- `PipelineRunStudioHistoryMaintenance`
- `PipelineRunStudioLauncher`
- `PipelineRunStudioLaunchRequest`
- `PipelineRunStudioLaunchResult`
- `PipelineRunStudioOptions`
- `PipelineRunStudioServer`
- `startPipelineRunStudio`

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
