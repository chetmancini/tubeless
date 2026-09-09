# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Package: `tubeless`

## Public entrypoints

| Entrypoint                   | Declaration                     | Surface hash                                                       | Exported symbols |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`                   | `./dist/pipeline.d.ts`          | `abac1ab32caa113df534505493463ec6f541a12b48b9078ac719ddcd9105d12b` |               73 |
| `tubeless/batch`             | `./dist/batch.d.ts`             | `27588caa380f4da6e57d372f586925d848887fb9c6ab54d4f777e9efac99f310` |                7 |
| `tubeless/cli`               | `./dist/cli.d.ts`               | `8e6818c722a36b9bd07b1bcd7083a40aa47e67665f1fa1ae2e73f7c8e79593b3` |               35 |
| `tubeless/node`              | `./dist/node.d.ts`              | `b4c61e41d408c1a0cfd980e60d8f33a7ea54c421070a9ac8e44ae226289e7e88` |                8 |
| `tubeless/rate-limit`        | `./dist/rate-limit.d.ts`        | `aab737b0631c10d8f5c8f6375ae12cc5b4b36b690ed6c6c9f0a15de920a8dacc` |                1 |
| `tubeless/render`            | `./dist/render.d.ts`            | `28a3afc9950dbb8afd19db81108a2a1cf7e03d0fd390a8c4aba122010065cf02` |                6 |
| `tubeless/reporter`          | `./dist/reporter-entry.d.ts`    | `57dd4da5148945ad8c0944d4ad4d2a17584018835109184d0c9da3c9d087c72c` |               13 |
| `tubeless/retry`             | `./dist/retry.d.ts`             | `061b927852fa5c08014df478901bcb4a20160a6f01c0c39ad3f2af142a87cb67` |                4 |
| `tubeless/run-store`         | `./dist/run-store.d.ts`         | `ea3a1e39ac1a758ca211a201d14551b5b37f3f9268f183603a3ebec69f5b528a` |               18 |
| `tubeless/run-store/sqlite`  | `./dist/run-store-sqlite.d.ts`  | `b8a4f86930a587b3b7c2b4c5a49ad43ec83886f9619104c659ade4eea51b1d78` |                3 |
| `tubeless/run-store/ndjson`  | `./dist/run-store-ndjson.d.ts`  | `2efb75ba7fa16b686a09d214fa842457a8ca63a963bc3650c5f54d85e522b6fe` |                3 |
| `tubeless/workbench/studio`  | `./dist/workbench-studio.d.ts`  | `4a7281c6cb6ac61bc980f5255edfe2955067122798094c3503cc31c0e2b7a3ca` |                6 |
| `tubeless/workbench/project` | `./dist/workbench-project.d.ts` | `f1ae252104509114296130608a3855d14b366c7148089d65e02a5a181f46d714` |                6 |
| `tubeless/run-store/ui`      | `./dist/run-store-ui.d.ts`      | `91eb9fb3b36f7c4a538a41d2911e21de254a67cb3d90e10579808f53cae3dfed` |                9 |
| `tubeless/testing`           | `./dist/testing.d.ts`           | `72196448ee41f57dda3971d7a7c71baf73547730d1ce215a7f923f85444c4651` |                7 |
| `tubeless/tracing`           | `./dist/tracing.d.ts`           | `abac1ab32caa113df534505493463ec6f541a12b48b9078ac719ddcd9105d12b` |                9 |
| `tubeless/tracing/json`      | `./dist/tracing-json.d.ts`      | `22aae997f772fd585f4ab0c0fc4f0c50b1c75d209dd1e932031161a83bd672e1` |                2 |
| `tubeless/tracing/otel`      | `./dist/tracing-otel.d.ts`      | `38e0ad6a9a952a13cb57a05802e4970fc79f84c1410c4b623d767e768858425a` |                4 |

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
