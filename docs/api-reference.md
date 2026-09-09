# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                   | Declaration                     | Surface hash                                                       | Exported symbols |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                   | `./dist/pipeline.d.ts`          | `b7d8e154dcc971ed83297c2c55ac7fbe101f3bc4b3c98bff0834397c0e69a535` |               73 |
| `tubeless/batch`             | `./dist/batch.d.ts`             | `27588caa380f4da6e57d372f586925d848887fb9c6ab54d4f777e9efac99f310` |                7 |
| `tubeless/cli`               | `./dist/cli.d.ts`               | `bbf83003d65ca161724b4e319b0d383e823e7f377713aa156d2c67a7c8356b4e` |               35 |
| `tubeless/node`              | `./dist/node.d.ts`              | `b4c61e41d408c1a0cfd980e60d8f33a7ea54c421070a9ac8e44ae226289e7e88` |                8 |
| `tubeless/rate-limit`        | `./dist/rate-limit.d.ts`        | `aab737b0631c10d8f5c8f6375ae12cc5b4b36b690ed6c6c9f0a15de920a8dacc` |                1 |
| `tubeless/render`            | `./dist/render.d.ts`            | `a280084c23b45907e1aaf6389609d5b770cd2a7a0787fdbaf26e0bc42099a5a4` |                6 |
| `tubeless/reporter`          | `./dist/reporter-entry.d.ts`    | `a88dc6f5174328b91975209fbe6b55b621222268e3535691528a055495cff37c` |               13 |
| `tubeless/retry`             | `./dist/retry.d.ts`             | `061b927852fa5c08014df478901bcb4a20160a6f01c0c39ad3f2af142a87cb67` |                4 |
| `tubeless/run-store`         | `./dist/run-store.d.ts`         | `695364cdd0c537b9b5ed7b5633be89424d0a51b451c4137953a51d9049153c00` |               18 |
| `tubeless/run-store/sqlite`  | `./dist/run-store-sqlite.d.ts`  | `f8311e5c3695c7bf051391b17ce8e8e39dc6a11cb1834ea7345a72a0bb77610f` |                3 |
| `tubeless/run-store/ndjson`  | `./dist/run-store-ndjson.d.ts`  | `55403d98773eca759f8c4f2b0f4e95dd86187efe3f005c2ca5aeecc1e76e6e85` |                3 |
| `tubeless/workbench/studio`  | `./dist/workbench-studio.d.ts`  | `4a7281c6cb6ac61bc980f5255edfe2955067122798094c3503cc31c0e2b7a3ca` |                6 |
| `tubeless/workbench/project` | `./dist/workbench-project.d.ts` | `f1ae252104509114296130608a3855d14b366c7148089d65e02a5a181f46d714` |                6 |
| `tubeless/run-store/ui`      | `./dist/run-store-ui.d.ts`      | `d2391bf9db44183cd1c021d554538f2df3583ff398911353084f4089be38e729` |                9 |
| `tubeless/testing`           | `./dist/testing.d.ts`           | `bc373957d3e2139f3559293c43d10c81d2d6a894a7db819451c7bb9ea1367477` |                7 |
| `tubeless/tracing`           | `./dist/tracing.d.ts`           | `b7d8e154dcc971ed83297c2c55ac7fbe101f3bc4b3c98bff0834397c0e69a535` |                9 |
| `tubeless/tracing/json`      | `./dist/tracing-json.d.ts`      | `9a5ffef1297a04f2564b3d226b0e83e1f753039d91da9df3c6239c33ba78aed5` |                2 |
| `tubeless/tracing/otel`      | `./dist/tracing-otel.d.ts`      | `680024a30fc5c9079f7edb12f33efeed45c4bd89be9b6280a42a229d5d713175` |                4 |

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

### `tubeless/workbench/studio`

- `definePipelineStudio`
- `isPipelineStudioConfig`
- `PIPELINE_STUDIO_CONFIG_VERSION`
- `PipelineStudioCommandModule`
- `PipelineStudioConfig`
- `PipelineStudioConfigInput`

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
