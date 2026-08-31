# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                  | Declaration                    | Surface hash                                                       | Exported symbols |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                  | `./dist/pipeline.d.ts`         | `0513b49cf2832ecebe2ab48adc05541d83adbdcf88eae8ef3a71dc2500cb0512` |               72 |
| `tubeless/batch`            | `./dist/batch.d.ts`            | `449dcacdeb67e2171c51fb1cb92a553c4aa05402fe6f3055d5c8222808b728cc` |                5 |
| `tubeless/cli`              | `./dist/cli.d.ts`              | `ed784468ac18d5aa57e5120dc84bf4fd5fc26f5b1794bd18df363a7fe6ddecbf` |               35 |
| `tubeless/node`             | `./dist/node.d.ts`             | `c466b60e1133c30a4d397ac48f473d6fffcf6b4f13258b200b0088132a86b4ff` |                8 |
| `tubeless/rate-limit`       | `./dist/rate-limit.d.ts`       | `c48e035d303232b27f11159859807a9a7e963b1099f1c7f1df77b9b2465bf571` |                1 |
| `tubeless/render`           | `./dist/render.d.ts`           | `ca8f0f7c23abab489f094d3552c3d7309037caaebd561a56c0708642688defed` |                6 |
| `tubeless/reporter`         | `./dist/reporter-entry.d.ts`   | `e8eae11ee59db51d3c3742a43ed40be738cf4b93ecb702052f9d9529043a640d` |               13 |
| `tubeless/retry`            | `./dist/retry.d.ts`            | `5cf9a605c718bb61cd9161e3aff14f1486671fec2e78dd15b8204bf305cf82b4` |                4 |
| `tubeless/run-store`        | `./dist/run-store.d.ts`        | `2b5c6672697e2a482f5f70c6c98a8dc0d27037133653ca54ea02de8afddefbeb` |               17 |
| `tubeless/run-store/sqlite` | `./dist/run-store-sqlite.d.ts` | `924545ed9ae5995489f3ec609752dc342b84873333a0cc84ca5ef66f5f9ce653` |                3 |
| `tubeless/workbench/studio` | `./dist/workbench-studio.d.ts` | `3f3079323c8e471a7ca9312eec3ade11083ced2eab4e158dd0a5592e6dd97cb8` |                6 |
| `tubeless/run-store/ui`     | `./dist/run-store-ui.d.ts`     | `efaaac978418af3f767b67edf9632a7e77d69479e42a0aa755cd57d3e7efc7a0` |                9 |
| `tubeless/testing`          | `./dist/testing.d.ts`          | `6600702edd1b218f9616ad701b201ce2af664e9c1db8047d6979d0da2a47e0df` |                7 |
| `tubeless/tracing`          | `./dist/tracing.d.ts`          | `0513b49cf2832ecebe2ab48adc05541d83adbdcf88eae8ef3a71dc2500cb0512` |                8 |
| `tubeless/tracing/json`     | `./dist/tracing-json.d.ts`     | `2995e02775e6f9264aacd60e76f6a54bf403b87c1f871f41d91bbccec6bcc234` |                2 |
| `tubeless/tracing/otel`     | `./dist/tracing-otel.d.ts`     | `fe1bb59ca3d6838cce1e90288eb74e74f4373b2ecc71c6448f2e45549f4efed2` |                4 |

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
