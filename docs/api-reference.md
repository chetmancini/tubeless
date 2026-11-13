# `tubeless` API reference

Generated from the package's emitted declaration files. Do not edit manually; run `bun run api:generate` from the package root.

Each symbol links to its source declaration and uses the first sentence of its public doc comment. Surface hashes cover declaration text with comments and whitespace removed.

Package: `tubeless`

## Public entrypoints

| Entrypoint                  | Declaration                               | Surface hash                                                       | Exported symbols |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `tubeless/agent/node`       | `./dist/agent/node.d.ts`                  | `c77cc7511595f76292751260d36cdcc7979902e4a6ba32d12fb437f52768638f` |                4 |
| `tubeless/agent`            | `./dist/agent/agent.d.ts`                 | `3dbae48d40b24c3e2b0e4c6032f40816b6428c7662f7a0b9d0d1ecac39751cb0` |               39 |
| `tubeless`                  | `./dist/core/pipeline.d.ts`               | `6bd9acad427e17154cb9c56e3b21c4cacef66e372f55d5b451886fcfbd03caad` |               78 |
| `tubeless/cli`              | `./dist/cli/cli.d.ts`                     | `4c8a8e6acf0a5046299d7739c2d04b52f034c44c4861a23902f98bffcbead0ae` |               31 |
| `tubeless/batch`            | `./dist/utilities/batch.d.ts`             | `856e4e759f1a62a4edd210d0291bc8b3d82b2e3e983bd37d7348bfb2b8993156` |                7 |
| `tubeless/node`             | `./dist/node/node.d.ts`                   | `89889b3747d6e597f8799d4bbfc3ee5fa811a76f0a9928e989b549ed91d8ecf7` |               14 |
| `tubeless/rate-limit`       | `./dist/utilities/rate-limit.d.ts`        | `21223a0ce096d7eb188e7aa38e4e0df70081b086f899dfea825b429308f6910e` |                1 |
| `tubeless/retry`            | `./dist/utilities/retry.d.ts`             | `ae8bdf0276b1930e4052f88a4912efe7dc6b857a8a51dcf2399eac0514fc9a0b` |                6 |
| `tubeless/project`          | `./dist/project/project.d.ts`             | `e27d3eae0a268166cd6c681815c75e322ac92cb32f4083c8ac6127691d48a125` |                9 |
| `tubeless/testing`          | `./dist/testing/testing.d.ts`             | `37fa6e609465c39dcf9e0faa45d7fd9411c8fd18141f71b6beec344be55fe0dc` |               10 |
| `tubeless/tracing`          | `./dist/tracing/tracing.d.ts`             | `7d52833c68a401c4fa69b221e5b7b37f9c2c0af089d02d8b89b8bdc8860ff1e2` |                4 |
| `tubeless/agent/openai`     | `./dist/agent/openai.d.ts`                | `e1bf470c1e6f433908b08f824fc01e355435999331a8fd3e020e12760e5c9d83` |                2 |
| `tubeless/agent/mcp`        | `./dist/agent/mcp.d.ts`                   | `5d60af3535a87d527222450e71863954a0ad4e3f672585af68ddc9d7e34eefa3` |                7 |
| `tubeless/agent/anthropic`  | `./dist/agent/anthropic.d.ts`             | `c3e3e6bad3bf562681b40eae299b724cac89769041118520c3290dce2725706f` |                2 |
| `tubeless/cloudflare`       | `./dist/cloudflare/cloudflare.d.ts`       | `bba65c25f58b335d38f7fab24140261e3104fd73cf248f4b8ecd75aa09371a64` |               13 |
| `tubeless/cloudflare/cache` | `./dist/cloudflare/cloudflare-cache.d.ts` | `6e2af51969db48b316dbcfc39ffac6654ca2cc9edaf51aec8ec06e3d43af1473` |                4 |

## Symbols

### `tubeless/agent/node`

| Symbol                                                                                                                         | Description                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`createNodeAgentEnvironment`](https://github.com/chetmancini/tubeless/blob/main/src/agent/node-environment.ts#L64)            | Local workspace capabilities with bounded reads, atomic writes and cancellable bash.                                                                                                              |
| [`createNodeCodemodeExecutor`](https://github.com/chetmancini/tubeless/blob/main/src/agent/codemode-node.ts#L22)               | Run each code-mode script in a fresh Node or Bun worker thread with heap limits, inside a `node:vm` context without string code generation, WebAssembly, `process`, `require`, `fetch` or timers. |
| [`openSqliteAgentCheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/agent/sqlite-checkpoint-store.ts#L37) | Open durable SQLite checkpoints; process exit automatically releases execution ownership.                                                                                                         |
| [`SqliteAgentCheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/agent/sqlite-checkpoint-store.ts#L9)      | File-backed checkpoint storage using Node's built-in SQLite and per-key file locks.                                                                                                               |

### `tubeless/agent`

| Symbol                                                                                                                          | Description                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`AgentCall`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L62)                                   | One selected default or custom call with raw model arguments; custom names replace defaults.     |
| [`AgentCheckpointCodec`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L16)                   | Lossless serialization for persisted state, validated arguments and outcomes.                    |
| [`AgentCheckpointLease`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L2)                    | Exclusive ownership of one execution's acknowledged checkpoint bytes.                            |
| [`AgentCheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L11)                   | Pluggable checkpoint persistence.                                                                |
| [`AgentDecision`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L91)                               | A nonempty batch of independent calls, or the raw input to the final-result schema.              |
| [`AgentDecisionContext`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L128)                       | Model-facing descriptors and ordinary step services, without executable tools.                   |
| [`AgentDurability`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L22)                        | Resume the same execution key on subsequent invocations with the same definition and inputs.     |
| [`AgentEnvironment`](https://github.com/chetmancini/tubeless/blob/main/src/agent/environment.ts#L15)                            | Filesystem and command capabilities supplied by a local or remote workspace.                     |
| [`AgentEnvironmentContext`](https://github.com/chetmancini/tubeless/blob/main/src/agent/environment.ts#L6)                      | Workspace and cancellation shared by an agent's environment operations.                          |
| [`AgentEnvironmentProvider`](https://github.com/chetmancini/tubeless/blob/main/src/agent/environment.ts#L79)                    | A workspace capability or a factory resolved once per live agent invocation.                     |
| [`AgentExecutionIdentity`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-types.ts#L30)                 | Stable durable identities for business idempotency and cross-attempt correlation.                |
| [`AgentLimits`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L108)                                | Finite limits for this agent and its descendants; child limits may only tighten them.            |
| [`AgentModel`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-types.ts#L25)                                  | Pluggable model transport; the harness owns and isolates its returned conversation per run.      |
| [`AgentModelDescriptors`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-types.ts#L19)                       | The model-facing descriptors one agent sends with every decision request.                        |
| [`AgentModelRequest`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-types.ts#L4)                            | Per-run provider context and the latest ordered tool outcomes, never executable handlers.        |
| [`AgentModelResponse`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-types.ts#L13)                          | An untrusted decision and complete plain-data conversation, including any final answer.          |
| [`AgentOutcome`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L82)                                | Input-order result or deliberately recoverable handler failure, including selected defaults.     |
| [`AgentProjectInstruction`](https://github.com/chetmancini/tubeless/blob/main/src/agent/environment.ts#L9)                      | One scoped guidance file, loaded by the workspace that owns it.                                  |
| [`AgentSession`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-session.ts#L30)                              | Sequential runs of one model-backed agent that continue a single conversation.                   |
| [`AgentState`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L11)                                  | Deeply read-only view of the owned plain-data state supplied to agent callbacks.                 |
| [`AgentTool`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L15)                                   | Opaque capability created by defineTool or pipelineTool; model decisions contain data only.      |
| [`AgentToolContext`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L122)                           | Step services and the workspace capability available to a registered tool.                       |
| [`CodemodeExecution`](https://github.com/chetmancini/tubeless/blob/main/src/agent/codemode-executor.ts#L4)                      | One script for an executor to run, with the JSON-text bridge to its tools.                       |
| [`CodemodeExecutionResult`](https://github.com/chetmancini/tubeless/blob/main/src/agent/codemode-executor.ts#L20)               | A script's JSON result text and console lines, or the error that ended it.                       |
| [`CodemodeExecutor`](https://github.com/chetmancini/tubeless/blob/main/src/agent/codemode-executor.ts#L39)                      | Runs code-mode scripts in an isolated sandbox.                                                   |
| [`CodemodeOptions`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L44)                             | Code-mode settings; the executor defaults to a Node worker thread.                               |
| [`CodemodeReply`](https://github.com/chetmancini/tubeless/blob/main/src/agent/codemode-executor.ts#L44)                         | The value or failure of one script call, as JSON text crossing into the sandbox.                 |
| [`CodemodeResult`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L37)                              | A code-mode script's JSON return value and bounded console lines.                                |
| [`CodemodeSetting`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L50)                             | `true` or options enable code mode; `false` or omission advertises the registry.                 |
| [`createAgentSession`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-session.ts#L54)                        | Continue one conversation across sequential runs of a `defineAgent` agent, such as chat prompts. |
| [`createMemoryAgentCheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/agent/memory-checkpoint-store.ts#L6) | In-memory checkpoint store with exclusive leases, useful for tests and embedded hosts.           |
| [`DefaultAgentToolName`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent-types.ts#L21)                        | A standard workspace tool an agent's setup may select.                                           |
| [`DefaultAgentTools`](https://github.com/chetmancini/tubeless/blob/main/src/agent/default-tools.ts#L210)                        | The read, write, edit, bash, list and search tools included in every agent.                      |
| [`defineAgent`](https://github.com/chetmancini/tubeless/blob/main/src/agent/model-agent.ts#L80)                                 | Prompt a model with `{ task }` and finish with the result schema, `{ answer }` by default.       |
| [`defineAgentLoop`](https://github.com/chetmancini/tubeless/blob/main/src/agent/agent.ts#L62)                                   | Build a bounded in-process agent as an ordinary pipeline with one target, agent.                 |
| [`defineTool`](https://github.com/chetmancini/tubeless/blob/main/src/agent/tools.ts#L57)                                        | Declare a validated handler capability; tools skip live work in dry runs by default.             |
| [`pipelineTool`](https://github.com/chetmancini/tubeless/blob/main/src/agent/pipeline-tool.ts#L25)                              | Reuse a compiled child's options schema and exact final result.                                  |
| [`plainAgentCheckpointCodec`](https://github.com/chetmancini/tubeless/blob/main/src/agent/checkpoint-codec.ts#L101)             | Lossless, tagged JSON codec for finite plain data; preserves undefined and sparse arrays.        |
| [`ToolError`](https://github.com/chetmancini/tubeless/blob/main/src/agent/tools.ts#L21)                                         | A handler may throw this error to return a recoverable observation to its agent.                 |

### `tubeless`

| Symbol                                                                                                                  | Description                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`ArtifactJsonValue`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/artifact-metadata.ts#L12)           | JSON values accepted in persisted artifact metadata.                                                 |
| [`ArtifactLoader`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-artifacts.ts#L11)                | Application-owned read boundary.                                                                     |
| [`ArtifactMetadata`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/artifact-metadata.ts#L21)            | Identifies an artifact without recording its contents.                                               |
| [`ArtifactRecord`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/artifact-metadata.ts#L132)             | A completed artifact operation recorded by a step; reuse does not claim a new write.                 |
| [`ArtifactResult`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-artifacts.ts#L5)                 | Adapter result: the value flows to dependents; only artifact metadata is recorded.                   |
| [`ArtifactSaver`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-artifacts.ts#L17)                 | Application-owned write boundary returning a typed receipt and separate trace metadata.              |
| [`createSteps`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-steps.ts#L67)                       | Create typed step constructors for one pipeline definition.                                          |
| [`definePipeline`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline.ts#L153)                         | Compile a typed step graph into a validated, executable pipeline.                                    |
| [`isPipelineErrorCode`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L202)              | Return whether an unknown value is a stable package-owned pipeline error code.                       |
| [`IterationDecision`](https://github.com/chetmancini/tubeless/blob/main/src/core/iteration.ts#L17)                      | Continue with a new state or publish the iteration step's final output.                              |
| [`IterationState`](https://github.com/chetmancini/tubeless/blob/main/src/core/iteration.ts#L14)                         | Read-only state supplied to an iteration's mapping and transition callbacks.                         |
| [`MappedChildProgressOptions`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-step-types.ts#L187)  | Presentation options for opaque `forEachPipeline` progress.                                          |
| [`Pipeline`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L581)                         | Compiled pipeline that can be planned, executed, and rendered as a graph.                            |
| [`PIPELINE_ERROR_CODES`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L194)             | Ordered catalog of every stable package-owned pipeline error code.                                   |
| [`PipelineCacheOptions`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L57)              | Defaults for opted-in steps; configuring defaults does not make other steps cacheable.               |
| [`PipelineContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L40)                   | Caller-supplied services and metadata shared by one pipeline execution.                              |
| [`PipelineDefinition`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-definition.ts#L87)           | Declarative configuration for compiling a typed pipeline.                                            |
| [`PipelineDefinitionError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-errors.ts#L21)          | Programmer error raised immediately when a pipeline graph is invalid.                                |
| [`PipelineDefinitionIdentity`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L12)        | Versioned graph identity, separate from the optional handler implementation version.                 |
| [`PipelineDefinitionSnapshot`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L18)        | Immutable snapshot of the compiled pipeline definition recorded for inspection and tracing.          |
| [`PipelineError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L235)                    | Structured, machine-readable error stored in plans, runs, and traces.                                |
| [`PipelineErrorCause`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L295)               | Bounded JSON-safe snapshot of a thrown value and its cause chain.                                    |
| [`PipelineErrorCode`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L197)                | Stable package-owned code for a pipeline error.                                                      |
| [`PipelineErrorKind`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L191)                | Broad category of a structured pipeline error.                                                       |
| [`PipelineErrorPhase`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L188)               | Pipeline lifecycle phase in which an error occurred.                                                 |
| [`PipelineExecutionContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L104)         | Resolved execution context provided to pipeline handlers.                                            |
| [`PipelineExecutionError`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-execution-error.ts#L119) | Error thrown by `runOrThrow` when a pipeline run does not complete successfully.                     |
| [`PipelineFanOutDiagnostics`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L224)        | Bounded diagnostics collected from a failed or cancelled fan-out step.                               |
| [`PipelineFanOutFailure`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L213)            | Bounded diagnostics for a failed or cancelled runtime fan-out.                                       |
| [`PipelineHooks`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L469)                    | Optional lifecycle callbacks, each receiving its own metadata snapshot.                              |
| [`PipelineInput`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L621)                    | Input accepted by a pipeline run before any options schema transformation.                           |
| [`PipelineLogger`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L33)                    | Minimal logger used by pipeline execution, reporters, and CLI adapters.                              |
| [`PipelineMermaidDirection`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L550)         | Supported Mermaid flowchart direction.                                                               |
| [`PipelineMermaidOptions`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L553)           | Rendering options for a pipeline Mermaid flowchart.                                                  |
| [`PipelineMetadata`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/graph-metadata.ts#L8)                | Descriptive only.                                                                                    |
| [`PipelineMetadataValue`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/graph-metadata.ts#L5)           | Bounded JSON values for descriptive pipeline and step annotations.                                   |
| [`PipelinePlan`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L538)                     | Side-effect-free validation and selection result for a pipeline run.                                 |
| [`PipelinePlanStep`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L497)                 | Planned representation of one declared step and its selection state.                                 |
| [`PipelineResult`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L627)                   | Successful result produced by a pipeline run.                                                        |
| [`PipelineRun`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L381)                      | Versioned public record returned for one pipeline execution.                                         |
| [`PipelineRunControls`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L66)               | Built-in run controls.                                                                               |
| [`PipelineRunStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L360)                | Terminal disposition of a completed run record.                                                      |
| [`PipelineStepCancelledEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L457)       | Lifecycle event emitted when a step is cancelled.                                                    |
| [`PipelineStepCancelledReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L336)      | Terminal report for a cancelled step.                                                                |
| [`PipelineStepCompleteEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L463)        | Lifecycle event emitted when a step completes successfully.                                          |
| [`PipelineStepCompleteReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L319)       | Terminal report for a successfully completed step.                                                   |
| [`PipelineStepContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L165)              | Step execution context with attempt identity and progress reporting helpers.                         |
| [`PipelineStepFailedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L459)          | Lifecycle event emitted when a step fails.                                                           |
| [`PipelineStepFailedReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L342)         | Terminal report for a failed step.                                                                   |
| [`PipelineStepLifecycleStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L443)      | Any planned, running, or terminal step lifecycle status.                                             |
| [`PipelineStepPlannedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L446)         | Lifecycle event emitted when a step is planned.                                                      |
| [`PipelineStepProgress`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L149)             | Latest progress snapshot reported by a running step.                                                 |
| [`PipelineStepProgressDetail`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L130)       | One optional nested row in a step progress snapshot.                                                 |
| [`PipelineStepProgressDetailStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L121) | Lifecycle status displayed for an optional nested progress row.                                      |
| [`PipelineStepProgressEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L453)        | Lifecycle event emitted when a running step reports progress.                                        |
| [`PipelineStepQuery`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-query.ts#L5)                  | Discovery filters combine with AND; tags require every exact, case-sensitive tag.                    |
| [`PipelineStepReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L350)               | Terminal state recorded for one step after a run.                                                    |
| [`PipelineStepReportStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L357)         | Terminal status recorded in a step report.                                                           |
| [`PipelineStepSelectionReason`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L486)      | Machine-readable explanation of why a planned step was included or omitted.                          |
| [`PipelineStepSkippedEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L461)         | Lifecycle event emitted when a step is skipped.                                                      |
| [`PipelineStepSkippedReport`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L326)        | Terminal report for a structurally or intentionally skipped step.                                    |
| [`PipelineStepSkipReason`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L397)           | Why a step did not run.                                                                              |
| [`PipelineStepStartEvent`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L449)           | Lifecycle event emitted when a step begins running.                                                  |
| [`PipelineStepStatus`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L426)               | One observable status in a step's planned → running → terminal lifecycle.                            |
| [`PipelineValidationIssue`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L207)          | One dependency-free Standard Schema issue normalized for reports and traces.                         |
| [`querySteps`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-query.ts#L23)                        | Return matching plan steps in execution order without changing selection or including prerequisites. |
| [`RemoteStepAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L179)                | Adapter that invokes one step on an external execution engine.                                       |
| [`requireOutputs`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-finalizer.ts#L38)                | Build a finalizer that only runs when every listed step published an output.                         |
| [`RUN_MODEL_VERSION`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-ids.ts#L2)                    | Current persisted run-record schema version.                                                         |
| [`StandardSchemaV1`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L253)                 | Dependency-free subset of the Standard Schema V1 protocol.                                           |
| [`Step`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-step-types.ts#L82)                         | Typed pipeline step carrying its stable ID, output, and option types.                                |
| [`StepCache`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L70)                         | Opt a deterministic ordinary step into caching, with optional overrides of pipeline defaults.        |
| [`StepCacheCodec`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L41)                    | Encode a detached snapshot; decode must produce a fresh handler-result value.                        |
| [`StepCacheContext`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L14)                  | Cache I/O is cancellable and independent of pipeline scheduling.                                     |
| [`StepCacheEntry`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L19)                    | Encoded raw handler result and its creation time; expiration is enforced by core.                    |
| [`StepCachePolicy`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L47)                   | Use reads and writes, recompute replaces entries, bypass performs no cache work.                     |
| [`StepCacheStore`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-cache.ts#L27)                    | Store timestamped encoded handler results; only undefined means a cache miss.                        |
| [`StepSkipDecision`](https://github.com/chetmancini/tubeless/blob/main/src/core/pipeline-types.ts#L418)                 | Decision from an optional `skip` predicate.                                                          |

### `tubeless/cli`

| Symbol                                                                                                                  | Description                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`CliBooleanParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L57)                         | Declarative configuration for a boolean command parameter.                          |
| [`CliCheckpointConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L216)                    | Checkpoint persistence settings for resumable commands.                             |
| [`CliCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L266)                             | Typed command that can parse, validate, execute, or own a CLI entry point.          |
| [`CliCommandConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L235)                       | Declarative configuration consumed by `defineCommand`.                              |
| [`CliCommandDescriptor`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L104)                   | Immutable, presentation-neutral command contract shared by CLI and UI adapters.     |
| [`CliContext`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L170)                             | Runtime services and environment passed to a command.                               |
| [`CliHelpRequested`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L207)                       | Control-flow error thrown when command help was requested.                          |
| [`CliNumberParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L45)                          | Declarative configuration for a numeric command parameter.                          |
| [`CliParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L76)                                | Any supported declarative command parameter configuration.                          |
| [`CliParameterDescriptor`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L82)                  | JSON-safe description of one validated command parameter for non-terminal clients.  |
| [`CliParams`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L163)                              | Validated values returned from a command's parameter schema.                        |
| [`CliParamsSchema`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L79)                         | Named parameter schema accepted by `defineCommand`.                                 |
| [`CliParamType`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L14)                            | Supported value kinds for declarative command parameters.                           |
| [`CliParseResult`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L189)                         | Successful values, help text, or validation errors returned by command parsing.     |
| [`CliPathParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L64)                            | Declarative configuration for a filesystem path command parameter.                  |
| [`CliStringParam`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L35)                          | Declarative configuration for a string command parameter.                           |
| [`CliValidationError`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-types.ts#L195)                     | Error thrown when command-line arguments fail schema validation.                    |
| [`defineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-command.ts#L319)                        | Create a typed command from a declarative parameter schema and run handler.         |
| [`definePipelineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L296)       | Turn a pipeline into a CLI; infer domain flags from its Standard JSON Schema input. |
| [`DefinePipelineCommandConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L149) | Configuration for a typed pipeline command.                                         |
| [`PipelineCliParseResult`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L56)       | Parse result returned by commands created with `definePipelineCommand`.             |
| [`PipelineCliValues`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L47)            | Validated domain parameters plus the built-in pipeline execution controls.          |
| [`PipelineCommand`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L62)              | Typed CLI facade over a pipeline with planning and graph helpers.                   |
| [`PipelineCommandHookConfig`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L102)   | Static or lazily constructed lifecycle hooks for a pipeline command.                |
| [`PipelineCommandHookContext`](https://github.com/chetmancini/tubeless/blob/main/src/cli/cli-pipeline-command.ts#L93)   | Parsed values and CLI services passed to a pipeline hook factory.                   |
| [`PipelineReporterConfig`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L51)  | Rendering and output settings for automatic, plain, or interactive reporting.       |
| [`PipelineReporterMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L33)    | Rendering mode selected for pipeline lifecycle reporting.                           |
| [`ReporterColorMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L6)                    | Policy for ANSI color in terminal reporter output.                                  |
| [`ReporterOutput`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/interactive-reporter.ts#L37)          | Writable terminal-like destination used by the interactive reporter.                |
| [`ReporterSymbolMode`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L8)                   | Symbol set used for step lifecycle markers in reporter output.                      |
| [`ReporterTerminalCapabilities`](https://github.com/chetmancini/tubeless/blob/main/src/reporter/reporter.ts#L11)        | Detected or caller-overridden terminal rendering capabilities.                      |

### `tubeless/batch`

| Symbol                                                                                                    | Description                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`ConcurrentPartialResult`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L34) | Execution outcome returned by `runConcurrentPartial`, discriminated by `ok`.                                                            |
| [`ConcurrentWorker`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L12)        | Asynchronous worker invoked for one input item by the concurrency helpers.                                                              |
| [`runBatched`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L147)             | Run fixed-size input batches with bounded concurrency and input-order results.                                                          |
| [`runBatchedPartial`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L167)      | Run fixed-size input batches with bounded concurrency, returning complete or partial results discriminated by `ok` instead of throwing. |
| [`runConcurrent`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L58)           | Run individual items with bounded, lazy scheduling and input-order results.                                                             |
| [`RunConcurrentOptions`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L4)     | Scheduling and cancellation settings for bounded concurrent work.                                                                       |
| [`runConcurrentPartial`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/batch.ts#L72)    | Return complete or partial results, discriminated by `ok`.                                                                              |

### `tubeless/node`

| Symbol                                                                                                                  | Description                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`CheckpointStore`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/checkpoint-store.ts#L2)             | Mutable set of completed item keys backed by an explicit JSON flush.                                                          |
| [`createFileStepCache`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/cache-storage.ts#L22)           | Persist timestamped cache entries with atomic replacement in a dedicated directory.                                           |
| [`createWorkerThreadAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L65)  | Run an explicit module export in a lazily created, reusable Node worker pool.                                                 |
| [`definePaths`](https://github.com/chetmancini/tubeless/blob/main/src/node/paths.ts#L11)                                | Create a factory that resolves a named set of workspace-relative paths.                                                       |
| [`openCheckpoint`](https://github.com/chetmancini/tubeless/blob/main/src/node/checkpoint.ts#L54)                        | Open a JSON checkpoint file, falling back to an empty store when it is absent.                                                |
| [`readJson`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L14)                              | Read and parse trusted JSON without runtime schema validation.                                                                |
| [`requireEnv`](https://github.com/chetmancini/tubeless/blob/main/src/node/env.ts#L2)                                    | Read a required non-empty environment variable or throw a contextual error.                                                   |
| [`resetDir`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L23)                              | Remove and recreate a directory for generated output.                                                                         |
| [`v8StepCacheCodec`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/cache-storage.ts#L10)              | Node's structured serialization, including undefined, Maps, Dates, and BigInts.                                               |
| [`withCheckpointedBatch`](https://github.com/chetmancini/tubeless/blob/main/src/node/checkpoint.ts#L101)                | Runs `persist()`, and only once it resolves without throwing, records every item in `batch` into `checkpoint` and flushes it. |
| [`WorkerThreadAdapter`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L25)        | Invoke cloneable payloads through a reusable pool of Node worker threads.                                                     |
| [`WorkerThreadAdapterOptions`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-adapter.ts#L13) | Configure the module export and worker-pool limits for a thread adapter.                                                      |
| [`WorkerThreadContext`](https://github.com/chetmancini/tubeless/blob/main/src/node/worker-thread-protocol.ts#L13)       | Explicit context supplied to the exported worker function; domain input is its first argument.                                |
| [`writeJson`](https://github.com/chetmancini/tubeless/blob/main/src/node/file-utils.ts#L5)                              | Serialize JSON and atomically replace the destination file.                                                                   |

### `tubeless/rate-limit`

| Symbol                                                                                            | Description                                                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`RateLimiter`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/rate-limit.ts#L4) | Serialize reservations at a fixed minimum interval with cancellation support. |

### `tubeless/retry`

| Symbol                                                                                                  | Description                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`DEFAULT_BASE_DELAY_MS`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L10) | Default `RetryOptions.baseDelayMs` when omitted.                                |
| [`DEFAULT_MAX_ATTEMPTS`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L8)   | Default `RetryOptions.maxAttempts` when omitted.                                |
| [`RetryAttemptContext`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L37)   | Metadata supplied to each retry operation attempt.                              |
| [`RetryOperation`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L47)        | Operation invoked once per retry attempt until it succeeds or the policy stops. |
| [`RetryOptions`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L13)          | Backoff, cancellation, and retry policy settings for `withRetry`.               |
| [`withRetry`](https://github.com/chetmancini/tubeless/blob/main/src/utilities/retry.ts#L77)             | Retry an asynchronous operation with exponential backoff and optional jitter.   |

### `tubeless/project`

| Symbol                                                                                                              | Description                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`CompiledPipelineDocument`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-compiler.ts#L15) | Immutable compiled pipelines and descriptive metadata from a parsed document.     |
| [`compilePipelineDocument`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-compiler.ts#L26)  | Compile parsed YAML or JSON into ordinary pipelines.                              |
| [`defineProject`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L81)            | Register each pipeline once, directly or through its explicit command.            |
| [`PipelineDocumentError`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-document.ts#L72)    | A document shape or reference error; graph errors remain PipelineDefinitionError. |
| [`PipelineDocumentMetadata`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-document.ts#L11) | Optional human-facing document information, never execution policy.               |
| [`PipelineProject`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L62)          | Immutable named pipeline collection, preserving each pipeline's exact type by id. |
| [`ProjectOptions`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L50)           | Optional project presentation, execution directory, and launched-run tracing.     |
| [`ProjectRegistry`](https://github.com/chetmancini/tubeless/blob/main/src/project/project-registry.ts#L79)          | Only explicitly registered functions and schemas can be referenced by a document. |
| [`ProjectTraceContext`](https://github.com/chetmancini/tubeless/blob/main/src/project/pipeline-project.ts#L42)      | Context for one CLI, Studio, or hosted command launch.                            |

### `tubeless/testing`

| Symbol                                                                                                        | Description                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`createPipelineTestRuntime`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L165)  | Create a deterministic runtime without installing a test framework or fake-timer package.   |
| [`overrideStep`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L26)                | Supply a resolved handler output, before the step's outputSchema validation/transformation. |
| [`PipelineTestClock`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L94)           | Monotonic caller-controlled clock used by a pipeline test runtime.                          |
| [`PipelineTestLogEntry`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L87)        | One silent logger call captured by a pipeline test runtime.                                 |
| [`PipelineTestLogLevel`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L84)        | Log levels captured by a pipeline test runtime.                                             |
| [`PipelineTestOverride`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L21)        | A typed step/value pair created by overrideStep; only accepted by test runs.                |
| [`PipelineTestRunControls`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L34)     | Test-only controls.                                                                         |
| [`PipelineTestRuntime`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L118)        | Framework-neutral runtime, observations, and typed execution helpers for pipeline tests.    |
| [`PipelineTestRuntimeOptions`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L108) | Clock, directory, and sleep overrides for a pipeline test runtime.                          |
| [`PipelineTestSleep`](https://github.com/chetmancini/tubeless/blob/main/src/testing/testing.ts#L101)          | Optional replacement for the default immediate, clock-advancing test sleep.                 |

### `tubeless/tracing`

| Symbol                                                                                                                   | Description                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [`composeTraceExporters`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing.ts#L16)                  | Fan one trace stream out to multiple exporters.                          |
| [`PipelineTraceEvent`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing-contracts.ts#L4)            | A versioned lifecycle record with an event-specific, structured payload. |
| [`PipelineTraceExporter`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing-contracts.ts#L7)         | Asynchronous boundary for trace destinations.                            |
| [`PipelineTraceExporterOptions`](https://github.com/chetmancini/tubeless/blob/main/src/tracing/tracing-contracts.ts#L13) | Application-owned destinations created once for each launched command.   |

### `tubeless/agent/openai`

| Symbol                                                                                            | Description                                                                                   |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`openaiModel`](https://github.com/chetmancini/tubeless/blob/main/src/agent/openai.ts#L58)        | Create a dependency-free OpenAI Responses model with native history and automatic compaction. |
| [`OpenAIModelOptions`](https://github.com/chetmancini/tubeless/blob/main/src/agent/openai.ts#L19) | Responses transport settings; credentials are resolved only when a decision executes.         |

### `tubeless/agent/mcp`

| Symbol                                                                                            | Description                                                                                    |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`connectMcpServers`](https://github.com/chetmancini/tubeless/blob/main/src/agent/mcp.ts#L183)    | Connect MCP servers and expose their tools to an agent, named `<server>__<tool>`.              |
| [`McpHttpOptions`](https://github.com/chetmancini/tubeless/blob/main/src/agent/mcp-http.ts#L11)   | A remote server reached over Streamable HTTP.                                                  |
| [`McpServer`](https://github.com/chetmancini/tubeless/blob/main/src/agent/mcp.ts#L22)             | A Streamable HTTP endpoint (`url`) or a local stdio command (`command`).                       |
| [`McpServers`](https://github.com/chetmancini/tubeless/blob/main/src/agent/mcp.ts#L29)            | Connected servers whose tools are named `<server>__<tool>`; close them after the agent's runs. |
| [`McpStdioOptions`](https://github.com/chetmancini/tubeless/blob/main/src/agent/mcp-stdio.ts#L10) | A local server process speaking JSON-RPC over stdin and stdout.                                |
| [`McpTool`](https://github.com/chetmancini/tubeless/blob/main/src/agent/mcp.ts#L26)               | A tool discovered on an MCP server, called with its validated JSON arguments.                  |
| [`McpToolResult`](https://github.com/chetmancini/tubeless/blob/main/src/agent/mcp-schema.ts#L256) | Content and optional structured data returned by an MCP tool call.                             |

### `tubeless/agent/anthropic`

| Symbol                                                                                                  | Description                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`anthropicModel`](https://github.com/chetmancini/tubeless/blob/main/src/agent/anthropic.ts#L79)        | Create a dependency-free Anthropic Messages model with native history and on-demand compaction. |
| [`AnthropicModelOptions`](https://github.com/chetmancini/tubeless/blob/main/src/agent/anthropic.ts#L25) | Messages API transport settings; credentials are resolved only when a decision executes.        |

### `tubeless/cloudflare`

| Symbol                                                                                                                               | Description                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [`CloudflareApp`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L55)                                | Worker handler and Durable Object classes that a Worker entry exports.                          |
| [`CloudflareAppOptions`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L37)                         | Options for createCloudflareApp.                                                                |
| [`CloudflareDurableObjectClass`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L52)                 | Durable Object class to export from the Worker entry under its binding's export name.           |
| [`CloudflareTraceContext`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L32)                       | Context for one admitted Cloudflare launch, including this Durable Object's bindings.           |
| [`CloudflareWorker`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L47)                             | Worker module handler to use as the Worker entry's default export.                              |
| [`createCloudflareApp`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare.ts#L110)                         | Compose a single-tenant Tubeless deployment for a Worker with two SQLite Durable Objects.       |
| [`createR2CacheStore`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L24)                     | Step cache entries in R2.                                                                       |
| [`createWorkerLoaderCodemodeExecutor`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-codemode.ts#L107) | Run each code-mode script in a fresh Cloudflare Dynamic Worker from a `worker_loaders` binding. |
| [`jsonCacheCodec`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L132)                        | Lossless JSON codec for Workers, where the default V8 codec is unavailable.                     |
| [`R2BucketLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L11)                           | Structural subset of an R2 bucket binding that the cache store uses.                            |
| [`R2ObjectLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L4)                            | Structural subset of an R2 object body that the cache store reads.                              |
| [`WorkerLoaderCodemodeOptions`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-codemode.ts#L22)         | Options for createWorkerLoaderCodemodeExecutor.                                                 |
| [`WorkerLoaderLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-codemode.ts#L11)                    | The `worker_loaders` binding's `load` method, as used by the code-mode executor.                |

### `tubeless/cloudflare/cache`

| Symbol                                                                                                           | Description                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`createR2CacheStore`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L24) | Step cache entries in R2.                                                   |
| [`jsonCacheCodec`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L132)    | Lossless JSON codec for Workers, where the default V8 codec is unavailable. |
| [`R2BucketLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L11)       | Structural subset of an R2 bucket binding that the cache store uses.        |
| [`R2ObjectLike`](https://github.com/chetmancini/tubeless/blob/main/src/cloudflare/cloudflare-cache.ts#L4)        | Structural subset of an R2 object body that the cache store reads.          |
