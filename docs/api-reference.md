# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                  | Declaration                    | Surface hash                                                       | Exported symbols |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                  | `./dist/pipeline.d.ts`         | `a8dd788d1fe880bdae3be51fc0de40665aac092a5369920dc8ae7eca28b8bfbb` |               71 |
| `tubeless/batch`            | `./dist/batch.d.ts`            | `2ae7ccbf0fb6582243d2a395c2d2b0fe561fd19d3850309321b7d270c5a8d015` |                5 |
| `tubeless/cli`              | `./dist/cli.d.ts`              | `7c44bb570491f7c418452c1e2c58ee73741bafc241bc914ae071a18b39e14bb4` |               35 |
| `tubeless/node`             | `./dist/node.d.ts`             | `d6f70752eb9e0ea752b8e2bfb9418f5d30bd46d790360504434fdfeb6a6f7414` |                8 |
| `tubeless/rate-limit`       | `./dist/rate-limit.d.ts`       | `a6b8642be882b01931597b1e0294094cb0a23fd9075c4d22aefe22d1ad1e5330` |                1 |
| `tubeless/render`           | `./dist/render.d.ts`           | `1e9e3c4f18d8cf6992ec48c7f793ebbfc3bc43219d8694fb6cee76da83d98479` |                6 |
| `tubeless/reporter`         | `./dist/reporter-entry.d.ts`   | `c2cf9ffaa7f5f80d1cb936b373782baeb2a33b1f2847fd7dbe3b36d7cc6dc199` |               13 |
| `tubeless/retry`            | `./dist/retry.d.ts`            | `8b93425242c618f533498fa9d1670d321e69c4bab7bfaa000ab2464c1b755f4a` |                4 |
| `tubeless/run-store`        | `./dist/run-store.d.ts`        | `be37dc529dc7cfd1f09c196eacb4664194a82bff62846bae94d318ab528d8d8a` |               16 |
| `tubeless/run-store/sqlite` | `./dist/run-store-sqlite.d.ts` | `559d146a8c3dfc18a8b247b39195fe48bd3094c6d1d91c419965cb139ee56264` |                3 |
| `tubeless/workbench/studio` | `./dist/workbench-studio.d.ts` | `2afced697589a4d76527107c9517921512c46ad62c074743264cb415a773539c` |                6 |
| `tubeless/run-store/ui`     | `./dist/run-store-ui.d.ts`     | `d207e9aba052d83ad2f4268b91644d932b7835e6c1a3eecb89df622a61db2041` |                9 |
| `tubeless/testing`          | `./dist/testing.d.ts`          | `a6e8a051df80bc56942c195d8fe62e4bb1e9436164c618abe703ffd51c9f1c34` |                7 |
| `tubeless/tracing`          | `./dist/tracing.d.ts`          | `aaa44ca17255d9da1ae3a2e29c0e62e4fc279de16b3526831023289d6d3c1b12` |                8 |
| `tubeless/tracing/json`     | `./dist/tracing-json.d.ts`     | `dcd58eb97dc8e08e2a5097a4f5435bf1d87901fb8c2b0bc387fcbce6d4caddc0` |                2 |
| `tubeless/tracing/otel`     | `./dist/tracing-otel.d.ts`     | `307853d3987eeb64a0ccdfb945933a0c1f016fe4f13b6ad8f3fe1e4045746814` |                4 |

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
- `MappedChildProgressDetail`
- `mappedChildProgressDetails`
- `MappedChildProgressOptions`
- `MappedChildProgressSnapshot`
- `mappedChildProgressUnits`
- `MappedChildProgressUnits`
- `Pipeline`
- `PIPELINE_FINALIZE_STEP_ID`
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
- `ConcurrentWorker`
- `runBatched`
- `runConcurrent`
- `RunConcurrentOptions`

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
- `MultiSelectChoice`
- `MultiSelectResult`
- `normalizeMultiSelectChoices`
- `parseMultiSelectInput`
- `ParseMultiSelectInputOptions`
- `PipelineCliBuiltins`
- `PipelineCliParseResult`
- `PipelineCliValues`
- `PipelineCommand`
- `PipelineCommandHookConfig`
- `PipelineCommandHookContext`
- `PipelineCommandHookSets`
- `promptMultiSelect`
- `PromptMultiSelectOptions`
- `TUBELESS_WORKBENCH_EXIT_CODE`

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

### `tubeless/run-store/sqlite`

- `openSqlitePipelineRunStore`
- `OpenSqlitePipelineRunStoreOptions`
- `SqlitePipelineRunStore`

### `tubeless/workbench/studio`

- `definePipelineStudio`
- `isPipelineStudioConfig`
- `PIPELINE_STUDIO_CONFIG_VERSION`
- `PipelineStudioCommandModule`
- `PipelineStudioConfig`
- `PipelineStudioConfigInput`

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

- `PipelineTraceAttributes`
- `PipelineTraceAttributeValue`
- `PipelineTraceContext`
- `PipelineTraceError`
- `PipelineTraceEvent`
- `PipelineTraceEventName`
- `PipelineTraceExporter`
- `PipelineTracingOptions`

### `tubeless/tracing/json`

- `createJsonTraceExporter`
- `JsonTraceExporterOptions`

### `tubeless/tracing/otel`

- `createOpenTelemetryTraceExporter`
- `OpenTelemetryLikeSpan`
- `OpenTelemetryLikeTracer`
- `OpenTelemetryTraceExporterOptions`
