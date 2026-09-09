# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                  | Declaration                    | Surface hash                                                       | Exported symbols |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                  | `./dist/pipeline.d.ts`         | `66b0efe2de8b8e6c690103168476ece579dfd28161c2cbeaa4c2ce1f67c26c71` |               73 |
| `tubeless/batch`            | `./dist/batch.d.ts`            | `27588caa380f4da6e57d372f586925d848887fb9c6ab54d4f777e9efac99f310` |                7 |
| `tubeless/cli`              | `./dist/cli.d.ts`              | `712f31f9ca366b232ffbaf04b6704d170b3dfa4a0e2f5ae6abbbf920c7dfcbe8` |               35 |
| `tubeless/node`             | `./dist/node.d.ts`             | `b4c61e41d408c1a0cfd980e60d8f33a7ea54c421070a9ac8e44ae226289e7e88` |                8 |
| `tubeless/rate-limit`       | `./dist/rate-limit.d.ts`       | `aab737b0631c10d8f5c8f6375ae12cc5b4b36b690ed6c6c9f0a15de920a8dacc` |                1 |
| `tubeless/render`           | `./dist/render.d.ts`           | `c753998ec61846459e963b7011d3f43bd2bf2f130b4aab33ec56eca94f5e8854` |                6 |
| `tubeless/reporter`         | `./dist/reporter-entry.d.ts`   | `df28e5f7215bb6fb23874c89b4492c54757615445406d568f53c36fa148153ea` |               13 |
| `tubeless/retry`            | `./dist/retry.d.ts`            | `061b927852fa5c08014df478901bcb4a20160a6f01c0c39ad3f2af142a87cb67` |                4 |
| `tubeless/run-store`        | `./dist/run-store.d.ts`        | `2d3bbeaa85fd1d18c2556023ba7dea05e6bfcb8feb92d692e27d79e7dc843558` |               17 |
| `tubeless/run-store/sqlite` | `./dist/run-store-sqlite.d.ts` | `7ec3284782c326c73f0c09ffaeada79a63947ceeb404596facd15304a263ea62` |                3 |
| `tubeless/workbench/studio` | `./dist/workbench-studio.d.ts` | `788cf3d69799227df3deba5af2df33aad6832cfea9bbee7d78ef04e19a8d33e6` |                6 |
| `tubeless/run-store/ui`     | `./dist/run-store-ui.d.ts`     | `fd00451c89652552a11ace32fdabaf255b98e2e42ea09d0e6c79c4b96a841644` |                9 |
| `tubeless/testing`          | `./dist/testing.d.ts`          | `0b67c424870ed075f8d24368b92f8562ebcef2a6952ac7a6758703e7574daef8` |                7 |
| `tubeless/tracing`          | `./dist/tracing.d.ts`          | `66b0efe2de8b8e6c690103168476ece579dfd28161c2cbeaa4c2ce1f67c26c71` |                8 |
| `tubeless/tracing/json`     | `./dist/tracing-json.d.ts`     | `5e30e789914f8ac6c2cf32458e966a47a61dfba61ee0971cbe1a01369203be48` |                2 |
| `tubeless/tracing/otel`     | `./dist/tracing-otel.d.ts`     | `05340ec88223bd67455368826d30b5497be2c1de4d6d205563556d64c31ebd3e` |                4 |

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
- `StoredRemote`

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
