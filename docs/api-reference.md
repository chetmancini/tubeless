# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                   | Declaration                               | Surface hash                                                       | Exported symbols |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                   | `./dist/core/pipeline.d.ts`               | `db7facf0dfc3bace7f0d12be2f38c43690074e8c21662614651c1588e19ed33a` |               73 |
| `tubeless/batch`             | `./dist/utilities/batch.d.ts`             | `6b7fe7d6eec6532cc835505517c3481e4290a2a606c2fddf6c80367f5c76c5f5` |                7 |
| `tubeless/cli`               | `./dist/cli/cli.d.ts`                     | `877c5f33138949cc2e29a15ddfe0ad8d11f5c8ab748cf2b7a0508707eaffbd95` |               35 |
| `tubeless/node`              | `./dist/node/node.d.ts`                   | `2ded0b2084ecf401c09b414d3af7108daf149192f0cbd7efc03f1ca7020b320f` |                8 |
| `tubeless/rate-limit`        | `./dist/utilities/rate-limit.d.ts`        | `5cd093bb780a19e44b087b01e2b38e06f07e7233c9920988ba399036e319c368` |                1 |
| `tubeless/render`            | `./dist/render/render.d.ts`               | `a10a12ca735ded364b5a0eed60a40c80ea555923549396158e4ec1276cec8e42` |                6 |
| `tubeless/reporter`          | `./dist/reporter/reporter-entry.d.ts`     | `bedc4c24e724761e44c0f4ebe1614ad5d7bee7cf9641d571c44f015cf253ead9` |               13 |
| `tubeless/retry`             | `./dist/utilities/retry.d.ts`             | `f91f83f8e31e3e629ed90d1b04656110572ea970187a92369f0908cd75ae8f00` |                4 |
| `tubeless/run-store`         | `./dist/run-store/run-store.d.ts`         | `585b629673bd702afce2255aa14953c3f159e8cf2f0458f72736b1f7a99d7f41` |               18 |
| `tubeless/run-store/sqlite`  | `./dist/run-store/run-store-sqlite.d.ts`  | `9ac13f04524903daba49aded034b4538bfe52268987a74191001905d436e1ff4` |                3 |
| `tubeless/run-store/ndjson`  | `./dist/run-store/run-store-ndjson.d.ts`  | `cc41441d1ddf19800e7cb2c21448750e964853e2ec1205574ed09e8745dbd95e` |                3 |
| `tubeless/workbench/studio`  | `./dist/workbench/workbench-studio.d.ts`  | `6108782771ca4752fa95473cf5cbb1353e0bf2cda32554cfd20fcfefb21010b8` |                6 |
| `tubeless/workbench/project` | `./dist/workbench/workbench-project.d.ts` | `eac0931b2968d98c1b7d41503c1ea61477a2685e8cfebd22863255fce67085a7` |                6 |
| `tubeless/run-store/ui`      | `./dist/studio/run-store-ui.d.ts`         | `c823d0d252c4f569f97cea07cc33dcfbb35531f634044b4e31057cf53b864b9c` |                9 |
| `tubeless/testing`           | `./dist/testing/testing.d.ts`             | `b20974bf733473984cbefc389cf89e36aeeaa04e132e333797bdb32ea1cc3670` |                7 |
| `tubeless/tracing`           | `./dist/tracing/tracing.d.ts`             | `db7facf0dfc3bace7f0d12be2f38c43690074e8c21662614651c1588e19ed33a` |                9 |
| `tubeless/tracing/json`      | `./dist/tracing/tracing-json.d.ts`        | `d7761e4d84af03048eead84264d0561715a8ff3bdad8dfde22bd2faa3bcabbef` |                2 |
| `tubeless/tracing/otel`      | `./dist/tracing/tracing-otel.d.ts`        | `e72a4056e75324ed063dfd866ded0d0c6b2d4b5030215e146c76c608f5925eb7` |                4 |

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
