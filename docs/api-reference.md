# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                   | Declaration                     | Surface hash                                                       | Exported symbols |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                   | `./dist/pipeline.d.ts`          | `a7d3f348d2959bdd1c756602ce3efae79f9a26ced0de0920e1414a553d46033e` |               73 |
| `tubeless/batch`             | `./dist/batch.d.ts`             | `27588caa380f4da6e57d372f586925d848887fb9c6ab54d4f777e9efac99f310` |                7 |
| `tubeless/cli`               | `./dist/cli.d.ts`               | `6fce94e849398af5323ab772862806e1a552683035e79d87cc27c06808f5edee` |               35 |
| `tubeless/node`              | `./dist/node.d.ts`              | `b4c61e41d408c1a0cfd980e60d8f33a7ea54c421070a9ac8e44ae226289e7e88` |                8 |
| `tubeless/rate-limit`        | `./dist/rate-limit.d.ts`        | `aab737b0631c10d8f5c8f6375ae12cc5b4b36b690ed6c6c9f0a15de920a8dacc` |                1 |
| `tubeless/render`            | `./dist/render.d.ts`            | `8c00eac0508e82f280a288ee429d4f123ca8f0d460bf238e29cad34d5e42a999` |                6 |
| `tubeless/reporter`          | `./dist/reporter-entry.d.ts`    | `d5f80bd81a1195f9c853c070a1a1915e6c91788fe0f626794843137ea5a79a22` |               13 |
| `tubeless/retry`             | `./dist/retry.d.ts`             | `061b927852fa5c08014df478901bcb4a20160a6f01c0c39ad3f2af142a87cb67` |                4 |
| `tubeless/run-store`         | `./dist/run-store.d.ts`         | `8b62c78356138e2c9e62a80a5f0d72d04ce36a3d6452a12eb7f3f16f9861705a` |               18 |
| `tubeless/run-store/sqlite`  | `./dist/run-store-sqlite.d.ts`  | `25e4347d0620e97c50c93e1ac389f296d3a05756313119a7a5fafb7c6f476a44` |                3 |
| `tubeless/run-store/ndjson`  | `./dist/run-store-ndjson.d.ts`  | `6d4301e976bdeba6ef0ddf7dfeaca5769c6c63a1072ef4758f7e6611f38e5941` |                3 |
| `tubeless/workbench/studio`  | `./dist/workbench-studio.d.ts`  | `4a7281c6cb6ac61bc980f5255edfe2955067122798094c3503cc31c0e2b7a3ca` |                6 |
| `tubeless/workbench/project` | `./dist/workbench-project.d.ts` | `f1ae252104509114296130608a3855d14b366c7148089d65e02a5a181f46d714` |                6 |
| `tubeless/run-store/ui`      | `./dist/run-store-ui.d.ts`      | `8e641c6d505766d96c25770164ed8bc691709b90f631827fd5c234bd45f7fecc` |                9 |
| `tubeless/testing`           | `./dist/testing.d.ts`           | `3e6d22012c17dd37c5dd71d9a0851aa16b604a05366dc46948134da4a06c20d3` |                7 |
| `tubeless/tracing`           | `./dist/tracing.d.ts`           | `a7d3f348d2959bdd1c756602ce3efae79f9a26ced0de0920e1414a553d46033e` |                9 |
| `tubeless/tracing/json`      | `./dist/tracing-json.d.ts`      | `b686044cb1c038f8c0ce1c76877bc1fd4b71faeccd5ce43ed02e9a98178f4dd7` |                2 |
| `tubeless/tracing/otel`      | `./dist/tracing-otel.d.ts`      | `5ca4ad278856b782387fba9dc5356187f89a81e94fb9c1f9acc7b19ce3dafc68` |                4 |

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
