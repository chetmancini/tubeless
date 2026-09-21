# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Each symbol links to its source declaration and uses the first sentence of its public doc comment.

Package: `tubeless`

## Public entrypoints

| Entrypoint            | Declaration                        | Surface hash                                                       | Exported symbols |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless`            | `./dist/core/pipeline.d.ts`        | `02b6e0554a598bf9bd588e2a286b3c4b31f5af026f8c1d83dbf805886bedb1a3` |               57 |
| `tubeless/cli`        | `./dist/cli/cli.d.ts`              | `45b9c7660e242e1935ad10afc39cf543396ae5a0344d24e63d89716db9e74932` |               31 |
| `tubeless/batch`      | `./dist/utilities/batch.d.ts`      | `ab57c16dc0d9a0b1d55eb1cfc0df32e6ee950037c09a98531ab64930206c2616` |                6 |
| `tubeless/node`       | `./dist/node/node.d.ts`            | `7117f2d9696c0f232ec9bdcc2d18ffa985ee57418881098f99ec9ab1fca53ac8` |               12 |
| `tubeless/rate-limit` | `./dist/utilities/rate-limit.d.ts` | `01029b2a9f1504a66e396804ccc63a5b43dbcb63c002dd47918e315a90ac2a3a` |                1 |
| `tubeless/retry`      | `./dist/utilities/retry.d.ts`      | `55fca324a49d3c077f24c3a11c7392cfc2d48dd576fa481246623b6a75ecbe30` |                4 |
| `tubeless/project`    | `./dist/project/project.d.ts`      | `1a15af98c61c66e95f367404fe82bce1cd32ae9fd0df087b8dccc81c75a7384e` |                5 |
| `tubeless/testing`    | `./dist/testing/testing.d.ts`      | `c4f339fc7a5cd8f6525d32298b990b571de61756864da6b3c4c3400ca1b38f0e` |                7 |
| `tubeless/tracing`    | `./dist/tracing/tracing.d.ts`      | `bde2a6b18d95b6d6311fec6ae8719ff432208e650803635c9355ec1af62dad27` |                3 |

## Symbols

### `tubeless`

| Symbol                                                                                                                 | Description                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`createSteps`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-steps.ts#L305)                     | Create typed step constructors for one pipeline definition.                                 |
| [`definePipeline`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline.ts#L135)                        | Compile a typed step graph into a validated, executable pipeline.                           |
| [`isPipelineErrorCode`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L175)             | Return whether an unknown value is a stable package-owned pipeline error code.              |
| [`MappedChildProgressOptions`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-steps.ts#L170)      | Presentation options for opaque `forEachPipeline` progress.                                 |
| [`Pipeline`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L509)                        | Compiled pipeline that can be planned, executed, and rendered as a graph.                   |
| [`PIPELINE_ERROR_CODES`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L167)            | Ordered catalog of every stable package-owned pipeline error code.                          |
| [`PipelineContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L35)                  | Caller-supplied services and metadata shared by one pipeline execution.                     |
| [`PipelineDefinition`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-definition.ts#L69)          | Declarative configuration for compiling a typed pipeline.                                   |
| [`PipelineDefinitionError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-errors.ts#L21)         | Programmer error raised immediately when a pipeline graph is invalid.                       |
| [`PipelineDefinitionIdentity`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L7)        | Versioned graph identity, separate from the optional handler implementation version.        |
| [`PipelineDefinitionSnapshot`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L13)       | Immutable snapshot of the compiled pipeline definition recorded for inspection and tracing. |
| [`PipelineError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L208)                   | Structured, machine-readable error stored in plans, runs, and traces.                       |
| [`PipelineErrorCause`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L267)              | Bounded JSON-safe snapshot of a thrown value and its cause chain.                           |
| [`PipelineErrorCode`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L170)               | Stable package-owned code for a pipeline error.                                             |
| [`PipelineErrorKind`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L164)               | Broad category of a structured pipeline error.                                              |
| [`PipelineErrorPhase`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L161)              | Pipeline lifecycle phase in which an error occurred.                                        |
| [`PipelineExecutionContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L83)         | Resolved execution context provided to pipeline handlers.                                   |
| [`PipelineExecutionError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-execute.ts#L75)         | Error thrown by `runOrThrow` when a pipeline run does not complete successfully.            |
| [`PipelineFanOutDiagnostics`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L197)       | Bounded diagnostics collected from a failed or cancelled fan-out step.                      |
| [`PipelineFanOutFailure`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L186)           | Bounded diagnostics for a failed or cancelled runtime fan-out.                              |
| [`PipelineHooks`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L424)                   | Optional callbacks for observing pipeline and step lifecycle events.                        |
| [`PipelineLogger`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L28)                   | Minimal logger used by pipeline execution, reporters, and CLI adapters.                     |
| [`PipelineMermaidDirection`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L498)        | Supported Mermaid flowchart direction.                                                      |
| [`PipelineMermaidOptions`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L501)          | Rendering options for a pipeline Mermaid flowchart.                                         |
| [`PipelinePlan`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L486)                    | Side-effect-free validation and selection result for a pipeline run.                        |
| [`PipelinePlanStep`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L452)                | Planned representation of one declared step and its selection state.                        |
| [`PipelineRun`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L333)                     | Versioned public record returned for one pipeline execution.                                |
| [`PipelineRunControls`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L53)              | Built-in controls for selecting and scheduling work in a pipeline run.                      |
| [`PipelineRunStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L330)               | Terminal disposition of a completed run record.                                             |
| [`PipelineStepCancelledEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L415)      | Lifecycle event emitted when a step is cancelled.                                           |
| [`PipelineStepCancelledReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L306)     | Terminal report for a cancelled step.                                                       |
| [`PipelineStepCompleteEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L421)       | Lifecycle event emitted when a step completes successfully.                                 |
| [`PipelineStepCompleteReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L289)      | Terminal report for a successfully completed step.                                          |
| [`PipelineStepContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L140)             | Step execution context with attempt identity and progress reporting helpers.                |
| [`PipelineStepFailedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L417)         | Lifecycle event emitted when a step fails.                                                  |
| [`PipelineStepFailedReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L312)        | Terminal report for a failed step.                                                          |
| [`PipelineStepLifecycleStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L401)     | Any planned, running, or terminal step lifecycle status.                                    |
| [`PipelineStepPlannedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L404)        | Lifecycle event emitted when a step is planned.                                             |
| [`PipelineStepProgress`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L124)            | Latest progress snapshot reported by a running step.                                        |
| [`PipelineStepProgressDetail`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L107)      | One optional nested row in a step progress snapshot.                                        |
| [`PipelineStepProgressDetailStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L98) | Lifecycle status displayed for an optional nested progress row.                             |
| [`PipelineStepProgressEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L411)       | Lifecycle event emitted when a running step reports progress.                               |
| [`PipelineStepReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L320)              | Terminal state recorded for one step after a run.                                           |
| [`PipelineStepReportStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L327)        | Terminal status recorded in a step report.                                                  |
| [`PipelineStepSelectionReason`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L441)     | Machine-readable explanation of why a planned step was included or omitted.                 |
| [`PipelineStepSkippedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L419)        | Lifecycle event emitted when a step is skipped.                                             |
| [`PipelineStepSkippedReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L296)       | Terminal report for a structurally or intentionally skipped step.                           |
| [`PipelineStepSkipReason`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L357)          | Why a step did not run.                                                                     |
| [`PipelineStepStartEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L407)          | Lifecycle event emitted when a step begins running.                                         |
| [`PipelineStepStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L386)              | One observable status in a step's planned → running → terminal lifecycle.                   |
| [`PipelineValidationIssue`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L180)         | One dependency-free Standard Schema issue normalized for reports and traces.                |
| [`RemoteStepAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L152)               | Adapter that invokes one step on an external execution engine.                              |
| [`requireOutputs`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-finalizer.ts#L31)               | Build a finalizer that only runs when every listed step published an output.                |
| [`RUN_MODEL_VERSION`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-ids.ts#L2)                   | Current persisted run-record schema version.                                                |
| [`StandardSchemaV1`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L226)                | Dependency-free subset of the Standard Schema V1 protocol.                                  |
| [`Step`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-steps.ts#L74)                             | Typed pipeline step carrying its stable ID, output, and option types.                       |
| [`StepSkipDecision`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L378)                | Decision from an optional `skip` predicate.                                                 |

### `tubeless/cli`

| Symbol                                                                                                                  | Description                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`CliBooleanParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L57)                         | Declarative configuration for a boolean command parameter.                          |
| [`CliCheckpointConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L213)                    | Checkpoint persistence settings for resumable commands.                             |
| [`CliCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L263)                             | Typed command that can parse, validate, execute, or own a CLI entry point.          |
| [`CliCommandConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L232)                       | Declarative configuration consumed by `defineCommand`.                              |
| [`CliCommandDescriptor`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L104)                   | Immutable, presentation-neutral command contract shared by CLI and UI adapters.     |
| [`CliContext`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L170)                             | Runtime services and environment passed to a command.                               |
| [`CliHelpRequested`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L204)                       | Control-flow error thrown when command help was requested.                          |
| [`CliNumberParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L45)                          | Declarative configuration for a numeric command parameter.                          |
| [`CliParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L76)                                | Any supported declarative command parameter configuration.                          |
| [`CliParameterDescriptor`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L82)                  | JSON-safe description of one validated command parameter for non-terminal clients.  |
| [`CliParams`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L163)                              | Validated values returned from a command's parameter schema.                        |
| [`CliParamsSchema`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L79)                         | Named parameter schema accepted by `defineCommand`.                                 |
| [`CliParamType`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L14)                            | Supported value kinds for declarative command parameters.                           |
| [`CliParseResult`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L186)                         | Successful values, help text, or validation errors returned by command parsing.     |
| [`CliPathParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L64)                            | Declarative configuration for a filesystem path command parameter.                  |
| [`CliStringParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L35)                          | Declarative configuration for a string command parameter.                           |
| [`CliValidationError`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L192)                     | Error thrown when command-line arguments fail schema validation.                    |
| [`defineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-command.ts#L401)                        | Create a typed command from a declarative parameter schema and run handler.         |
| [`definePipelineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L237)       | Turn a pipeline into a CLI; infer domain flags from its Standard JSON Schema input. |
| [`DefinePipelineCommandConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L134) | Configuration for a typed pipeline command.                                         |
| [`PipelineCliParseResult`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L47)       | Parse result returned by commands created with `definePipelineCommand`.             |
| [`PipelineCliValues`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L39)            | Validated domain parameters plus the built-in pipeline execution controls.          |
| [`PipelineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L53)              | Typed CLI facade over a pipeline with planning and graph helpers.                   |
| [`PipelineCommandHookConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L87)    | Static or lazily constructed lifecycle hooks for a pipeline command.                |
| [`PipelineCommandHookContext`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L78)   | Parsed values and CLI services passed to a pipeline hook factory.                   |
| [`PipelineReporterConfig`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L47)  | Rendering and output settings for automatic, plain, or interactive reporting.       |
| [`PipelineReporterMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L29)    | Rendering mode selected for pipeline lifecycle reporting.                           |
| [`ReporterColorMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L6)                    | Policy for ANSI color in terminal reporter output.                                  |
| [`ReporterOutput`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L33)          | Writable terminal-like destination used by the interactive reporter.                |
| [`ReporterSymbolMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L8)                   | Symbol set used for step lifecycle markers in reporter output.                      |
| [`ReporterTerminalCapabilities`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L11)        | Detected or caller-overridden terminal rendering capabilities.                      |

### `tubeless/batch`

| Symbol                                                                                                   | Description                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`ConcurrentSettleResult`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L34) | Partial results and first failure returned by `runConcurrentSettled`.                          |
| [`ConcurrentWorker`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L12)       | Asynchronous worker invoked for one input item by the concurrency helpers.                     |
| [`runBatched`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L134)            | Run fixed-size input batches with bounded concurrency and input-order results.                 |
| [`runConcurrent`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L49)          | Run individual items with bounded, lazy scheduling and input-order results.                    |
| [`RunConcurrentOptions`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L4)    | Scheduling and cancellation settings for bounded concurrent work.                              |
| [`runConcurrentSettled`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L61)   | Like `runConcurrent`, but returns completed results and the first failure instead of throwing. |

### `tubeless/node`

| Symbol                                                                                                                  | Description                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`CheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/node/checkpoint.ts#L5)                        | Mutable set of completed item keys backed by an explicit JSON flush.                                                          |
| [`createWorkerThreadAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L64)  | Run an explicit module export in a lazily created, reusable Node worker pool.                                                 |
| [`definePaths`](https://github.com/chetmancini/tubeless/blob/main/src/node/paths.ts#L11)                                | Create a factory that resolves a named set of workspace-relative paths.                                                       |
| [`openCheckpoint`](https://github.com/chetmancini/tubeless/blob/main/src/node/checkpoint.ts#L66)                        | Open a JSON checkpoint file, falling back to an empty store when it is absent.                                                |
| [`readJson`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L14)                              | Read and parse trusted JSON without runtime schema validation.                                                                |
| [`requireEnv`](https://github.com/chetmancini/tubeless/blob/main/src/node/env.ts#L2)                                    | Read a required non-empty environment variable or throw a contextual error.                                                   |
| [`resetDir`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L23)                              | Remove and recreate a directory for generated output.                                                                         |
| [`withCheckpointedBatch`](https://github.com/chetmancini/tubeless/blob/main/src/node/checkpoint.ts#L113)                | Runs `persist()`, and only once it resolves without throwing, records every item in `batch` into `checkpoint` and flushes it. |
| [`WorkerThreadAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L24)        | Invoke cloneable payloads through a reusable pool of Node worker threads.                                                     |
| [`WorkerThreadAdapterOptions`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L12) | Configure the module export and worker-pool limits for a thread adapter.                                                      |
| [`WorkerThreadContext`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-protocol.ts#L14)       | Provide cancellation, logging, progress, and run metadata to a worker export.                                                 |
| [`writeJson`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L5)                              | Serialize JSON and atomically replace the destination file.                                                                   |

### `tubeless/rate-limit`

| Symbol                                                                                            | Description                                                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`RateLimiter`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/rate-limit.ts#L4) | Serialize reservations at a fixed minimum interval with cancellation support. |

### `tubeless/retry`

| Symbol                                                                                                | Description                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`RetryAttemptContext`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L21) | Metadata supplied to each retry operation attempt.                              |
| [`RetryOperation`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L31)      | Operation invoked once per retry attempt until it succeeds or the policy stops. |
| [`RetryOptions`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L4)         | Backoff, cancellation, and retry policy settings for `withRetry`.               |
| [`withRetry`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L58)           | Retry an asynchronous operation with exponential backoff and optional jitter.   |

### `tubeless/project`

| Symbol                                                                                                           | Description                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`defineProject`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L65)         | Define an immutable project from typed pipelines or a parsed pipeline document.   |
| [`PipelineDocumentError`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-document.ts#L72) | A document shape or reference error; graph errors remain PipelineDefinitionError. |
| [`PipelineProject`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L50)       | Immutable named pipeline collection, preserving each pipeline's exact type by id. |
| [`ProjectOptions`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L32)        | Optional project presentation and CLI adapters.                                   |
| [`ProjectRegistry`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-compiler.ts#L90)       | Only explicitly registered functions and schemas can be referenced by a document. |

### `tubeless/testing`

| Symbol                                                                                                       | Description                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [`createPipelineTestRuntime`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L97)  | Create a deterministic runtime without installing a test framework or fake-timer package. |
| [`PipelineTestClock`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L26)          | Monotonic caller-controlled clock used by a pipeline test runtime.                        |
| [`PipelineTestLogEntry`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L19)       | One silent logger call captured by a pipeline test runtime.                               |
| [`PipelineTestLogLevel`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L16)       | Log levels captured by a pipeline test runtime.                                           |
| [`PipelineTestRuntime`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L50)        | Framework-neutral runtime, observations, and typed execution helpers for pipeline tests.  |
| [`PipelineTestRuntimeOptions`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L40) | Clock, directory, and sleep overrides for a pipeline test runtime.                        |
| [`PipelineTestSleep`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L33)          | Optional replacement for the default immediate, clock-advancing test sleep.               |

### `tubeless/tracing`

| Symbol                                                                                                           | Description                                                              |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`composeTraceExporters`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing.ts#L12)          | Fan one trace stream out to multiple exporters.                          |
| [`PipelineTraceEvent`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing-contracts.ts#L4)    | A versioned lifecycle record with an event-specific, structured payload. |
| [`PipelineTraceExporter`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing-contracts.ts#L7) | Asynchronous boundary for trace destinations.                            |
