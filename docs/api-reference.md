# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                   | Declaration                               | Surface hash                                                       | Exported symbols |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                   | `./dist/core/pipeline.d.ts`               | `ad21029671e1af6e56a958aaf12233590e336bdefb8158422ed8aec608f0ccbb` |               75 |
| `tubeless/batch`             | `./dist/utilities/batch.d.ts`             | `6b7fe7d6eec6532cc835505517c3481e4290a2a606c2fddf6c80367f5c76c5f5` |                7 |
| `tubeless/cli`               | `./dist/cli/cli.d.ts`                     | `1d8e582894b935d491ab040bf804fe94ca4007cc9c1041e5205176b05b03c6b5` |               35 |
| `tubeless/node`              | `./dist/node/node.d.ts`                   | `2ded0b2084ecf401c09b414d3af7108daf149192f0cbd7efc03f1ca7020b320f` |                8 |
| `tubeless/rate-limit`        | `./dist/utilities/rate-limit.d.ts`        | `5cd093bb780a19e44b087b01e2b38e06f07e7233c9920988ba399036e319c368` |                1 |
| `tubeless/render`            | `./dist/render/render.d.ts`               | `9c3d22e178d3cfc392d71a56f9d4e6ca0f10572348021d05b8a41e54d56e634a` |                6 |
| `tubeless/reporter`          | `./dist/reporter/reporter-entry.d.ts`     | `4cd18138b0cfffe46212b7a4305d2d5a0d6a3b9b5007e32bde7e37f3edf6a1bb` |               13 |
| `tubeless/retry`             | `./dist/utilities/retry.d.ts`             | `f91f83f8e31e3e629ed90d1b04656110572ea970187a92369f0908cd75ae8f00` |                4 |
| `tubeless/run-store`         | `./dist/run-store/run-store.d.ts`         | `6c119fac4a6367156e7ec0672571d6e79bb0f15da173cca7a026b72e312d888f` |               18 |
| `tubeless/run-store/sqlite`  | `./dist/run-store/run-store-sqlite.d.ts`  | `f77d7be41a724a8b6885187967f5552813f983fc6419711f6dcf77d868697efb` |                3 |
| `tubeless/run-store/ndjson`  | `./dist/run-store/run-store-ndjson.d.ts`  | `f6587e60bb8dfd19dfbd5690a8ed674a268d5bd2ab5b2245656b394a665e27af` |                3 |
| `tubeless/workbench/studio`  | `./dist/workbench/workbench-studio.d.ts`  | `6108782771ca4752fa95473cf5cbb1353e0bf2cda32554cfd20fcfefb21010b8` |                6 |
| `tubeless/workbench/project` | `./dist/workbench/workbench-project.d.ts` | `eac0931b2968d98c1b7d41503c1ea61477a2685e8cfebd22863255fce67085a7` |                6 |
| `tubeless/run-store/ui`      | `./dist/studio/run-store-ui.d.ts`         | `de6de4fdc117fafe6e75d0e9ba760597658ec8a9c80779c64dadc432e377e8f5` |                9 |
| `tubeless/testing`           | `./dist/testing/testing.d.ts`             | `45c0f25077e6924e5fa07a14c7820a03c8b5d72efaa96dfadc713262b506eb4e` |                7 |
| `tubeless/tracing`           | `./dist/tracing/tracing.d.ts`             | `ad21029671e1af6e56a958aaf12233590e336bdefb8158422ed8aec608f0ccbb` |                9 |
| `tubeless/tracing/json`      | `./dist/tracing/tracing-json.d.ts`        | `b0572e3cd26cebea1d3ba03f98e6c481f17d722e71da21b33b65b82e8b25ea39` |                2 |
| `tubeless/tracing/otel`      | `./dist/tracing/tracing-otel.d.ts`        | `7f60f1d0dc6b36fda098827e6c1166dcc7cbbfb971f63e097d0b01378a923f3d` |                4 |

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
