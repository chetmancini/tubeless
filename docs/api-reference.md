# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                   | Declaration                               | Surface hash                                                       | Exported symbols |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                   | `./dist/core/pipeline.d.ts`               | `b45e0b5022c3129e9f435c4f2f312ae72aa4ec9aebfb20860260700d8eb7e149` |               75 |
| `tubeless/batch`             | `./dist/utilities/batch.d.ts`             | `6b7fe7d6eec6532cc835505517c3481e4290a2a606c2fddf6c80367f5c76c5f5` |                7 |
| `tubeless/cli`               | `./dist/cli/cli.d.ts`                     | `6160f368beb0ff00e6102e4c91ef1539713fcf6f492c06f22359afabe1ea7531` |               35 |
| `tubeless/node`              | `./dist/node/node.d.ts`                   | `2ded0b2084ecf401c09b414d3af7108daf149192f0cbd7efc03f1ca7020b320f` |                8 |
| `tubeless/rate-limit`        | `./dist/utilities/rate-limit.d.ts`        | `5cd093bb780a19e44b087b01e2b38e06f07e7233c9920988ba399036e319c368` |                1 |
| `tubeless/render`            | `./dist/render/render.d.ts`               | `6a0e519daeb6255f5a3f9699b591888042bd987db27d1b6569ac2d262c860712` |                6 |
| `tubeless/reporter`          | `./dist/reporter/reporter-entry.d.ts`     | `2defa41a04366f8d3d8713e6fdbccea895764d7740bc9fbf7467e543c94d93f3` |               13 |
| `tubeless/retry`             | `./dist/utilities/retry.d.ts`             | `f91f83f8e31e3e629ed90d1b04656110572ea970187a92369f0908cd75ae8f00` |                4 |
| `tubeless/run-store`         | `./dist/run-store/run-store.d.ts`         | `51c38a6ba01644bf61b09b99fb69ff855ec4ad18f3761ddcee6fa9da31d3931a` |               18 |
| `tubeless/run-store/sqlite`  | `./dist/run-store/run-store-sqlite.d.ts`  | `3a6920bbd8d703d27f763b681ddedf37e149231318b67205e869f45e9b20175a` |                3 |
| `tubeless/run-store/ndjson`  | `./dist/run-store/run-store-ndjson.d.ts`  | `fac7a57eba121f6d8e71de080aec8b0e98f3d99d3cb06a4e35805186d209f3be` |                3 |
| `tubeless/workbench/studio`  | `./dist/workbench/workbench-studio.d.ts`  | `6108782771ca4752fa95473cf5cbb1353e0bf2cda32554cfd20fcfefb21010b8` |                6 |
| `tubeless/workbench/project` | `./dist/workbench/workbench-project.d.ts` | `eac0931b2968d98c1b7d41503c1ea61477a2685e8cfebd22863255fce67085a7` |                6 |
| `tubeless/run-store/ui`      | `./dist/studio/run-store-ui.d.ts`         | `25bc0f23643acf6ce29d0d889cb05ff115f4c09c900cbdf5a0413799e246ca5b` |                9 |
| `tubeless/testing`           | `./dist/testing/testing.d.ts`             | `d1dcb292fa5c658b6dd7cad8459c23cbac7b7e3fccdeb3641bb5d5973c1c4636` |                7 |
| `tubeless/tracing`           | `./dist/tracing/tracing.d.ts`             | `b45e0b5022c3129e9f435c4f2f312ae72aa4ec9aebfb20860260700d8eb7e149` |                9 |
| `tubeless/tracing/json`      | `./dist/tracing/tracing-json.d.ts`        | `f1ab54da19823bd0eb37f0533e3b02641dc963bea96ef9e5a9c72967f018321f` |                2 |
| `tubeless/tracing/otel`      | `./dist/tracing/tracing-otel.d.ts`        | `7ac57f29673b589ae685502721b6c10bd8d723bcf6adb9e0ee305fe23b2d0ef1` |                4 |

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
