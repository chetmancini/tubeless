import { throwIfAborted } from "../utilities/abort.js";
import {
  STEP_AGENT,
  STEP_INPUT,
  STEP_NESTED_PIPELINE,
  STEP_ORCHESTRATION,
} from "./pipeline-step-metadata.js";
import type { AnyStep } from "./pipeline-steps.js";
import type {
  PipelineContext,
  PipelineExecutionContext,
  PipelineExecutionJournal,
  PipelineDefinitionIdentity,
  PipelinePlan,
  PipelineRunControls,
  PipelineRuntime,
} from "./pipeline-types.js";

const JOURNAL_SCOPE: unique symbol = Symbol("tubeless.executionJournal");
interface JournalScope {
  readonly session: {
    readonly journal: PipelineExecutionJournal;
    failure?: JournalFailure;
  };
  readonly path: readonly string[];
}
type Scoped = { [JOURNAL_SCOPE]?: JournalScope };

/** Keep infrastructure failure distinct from handler failure and signal cancellation. */
class JournalFailure extends Error {
  readonly code: string;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PipelineJournalError";
    this.code =
      cause instanceof Error && "code" in cause && typeof cause.code === "string"
        ? cause.code
        : "TUBELESS_EXECUTION_JOURNAL_FAILED";
  }
}

function journalError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function scope(context: object): JournalScope | undefined {
  const runtime = context as Scoped & Partial<PipelineContext>;
  return runtime.executionJournal ? runtime[JOURNAL_SCOPE] : undefined;
}

export function journalFailure(context: object): Error | undefined {
  return scope(context)?.session.failure;
}

export function assertJournalHealthy(context: object): void {
  const failure = journalFailure(context);
  if (failure) throw failure;
}

/** Include native checkpoint decoding and compatibility checks in the host failure boundary. */
export async function withExecutionJournal<T>(context: object, work: () => Promise<T>): Promise<T> {
  const current = scope(context);
  if (!current) return work();
  try {
    return await work();
  } catch (error) {
    const failure = error instanceof JournalFailure ? error : new JournalFailure(error);
    current.session.failure ??= failure;
    throw failure;
  }
}

/** Each root invocation owns fresh failure state; children share it and extend only their path. */
export function executionJournalRuntime(
  context: PipelineRuntime,
  pipelineId: string,
  enabled: boolean
): PipelineRuntime & Pick<PipelineExecutionContext<object>, "executionJournalPath"> & Scoped {
  const journal = enabled ? context.executionJournal : undefined;
  if (!journal) return { ...context, executionJournal: undefined };
  const inherited = scope(context);
  const session = inherited?.session ?? { journal };
  const path = Object.freeze([
    ...(inherited?.path ?? ["v1", "execution", journal.key]),
    "pipeline",
    pipelineId,
  ]);
  return { ...context, [JOURNAL_SCOPE]: { session, path }, executionJournalPath: path };
}

/** Composition supplies logical identity; path kinds prevent item keys from aliasing iterations. */
export function inheritExecutionJournal<T extends PipelineContext>(
  context: PipelineExecutionContext<object>,
  target: T,
  identity: { stepId: string; itemKey?: string; iterationIndex?: number },
  dryRun: boolean
): T {
  const inherited = scope(context);
  if (!dryRun && inherited) {
    const occurrence =
      identity.iterationIndex !== undefined
        ? ["iteration", String(identity.iterationIndex)]
        : identity.itemKey === undefined
          ? ["single"]
          : ["item", identity.itemKey];
    target.executionJournal = context.executionJournal;
    Object.assign(target, {
      [JOURNAL_SCOPE]: {
        session: inherited.session,
        path: Object.freeze([...inherited.path, "step", identity.stepId, ...occurrence]),
      },
    });
  }
  return target;
}

export async function bindExecutionJournal(
  context: object,
  suffix: readonly string[],
  value: unknown
): Promise<void> {
  const current = scope(context);
  if (!current) return;
  assertJournalHealthy(context);
  await withExecutionJournal(context, () =>
    current.session.journal.bind([...current.path, ...suffix], value)
  );
}

export async function bindJournalInput(
  context: PipelineContext,
  definition: PipelineDefinitionIdentity,
  input: object,
  controls: PipelineRunControls,
  plan: PipelinePlan
): Promise<void> {
  const current = scope(context);
  if (!current) return;
  await withExecutionJournal(context, async () => {
    if ((controls.suppliedOutputs?.size ?? 0) > 0)
      throw journalError(
        "TUBELESS_JOURNAL_SUPPLIED_OUTPUTS_UNSUPPORTED",
        "Supplied outputs cannot bypass an active execution journal; use one recovery authority"
      );
    if (
      typeof definition.implementationVersion !== "string" ||
      !definition.implementationVersion.trim()
    )
      throw journalError(
        "TUBELESS_JOURNAL_IMPLEMENTATION_VERSION_REQUIRED",
        "Journaled pipelines require an explicit implementationVersion"
      );
    if (typeof current.session.journal.key !== "string" || !current.session.journal.key.trim())
      throw new TypeError("Execution journal requires a nonblank logical execution key");
    await bindExecutionJournal(context, ["input"], {
      version: 1,
      definition,
      input,
      cwd: context.cwd,
      controls: {
        cache: controls.cache,
        continueOnError: controls.continueOnError ?? false,
        maxConcurrency: controls.maxConcurrency ?? 1,
        dryRun: false,
        selected: plan.steps.filter((step) => step.selected).map((step) => step.id),
      },
    });
  });
}

/** Apply the recovery protocol around a step; handler failures stay outside host acknowledgement. */
export async function executeWithJournal<TOptions extends object>(
  step: AnyStep<TOptions>,
  inputs: Record<string, unknown>,
  context: PipelineExecutionContext<TOptions>,
  run: (context: PipelineExecutionContext<TOptions>) => Promise<unknown>
): Promise<unknown> {
  const current = scope(context);
  if (!current) return run(context);
  const path = Object.freeze([...current.path, "step", step.id]);
  const boundary =
    step[STEP_AGENT] !== undefined
      ? "agent"
      : step[STEP_NESTED_PIPELINE] || step[STEP_ORCHESTRATION] || step[STEP_INPUT]
        ? "orchestration"
        : "effect";
  const saved =
    boundary === "agent"
      ? undefined
      : await withExecutionJournal(context, async () => {
          assertJournalHealthy(context);
          const saved = await current.session.journal.begin(path, inputs, boundary);
          if (
            !saved ||
            !["new", "incomplete", "completed"].includes(saved.status) ||
            (saved.status === "completed" && !Object.hasOwn(saved, "value"))
          )
            throw journalError(
              "TUBELESS_JOURNAL_INVALID_RESPONSE",
              "Invalid execution journal begin response"
            );
          if (saved.status === "incomplete" && boundary === "effect")
            throw journalError(
              "TUBELESS_JOURNAL_OUTCOME_UNKNOWN",
              "An ordinary step was interrupted before completion acknowledgement; reconcile its effects before continuing"
            );
          return saved;
        });
  // A cancelled begin never grants permission to start a handler.
  throwIfAborted(context.signal, "Pipeline run");
  assertJournalHealthy(context);
  if (saved?.status === "completed") return saved.value;
  const output = await run({ ...context, executionJournalPath: path });
  if (boundary === "agent") assertJournalHealthy(context);
  // Drain active effects even after a sibling fails; acknowledged results remain recoverable.
  else await withExecutionJournal(context, () => current.session.journal.complete(path, output));
  return output;
}

export function journalAgentStore(
  context: PipelineExecutionContext<object>,
  explicit?: PipelineExecutionJournal["agentStore"]
): NonNullable<PipelineExecutionJournal["agentStore"]> {
  const store = explicit ?? context.executionJournal?.agentStore;
  if (!store)
    throw journalError(
      "TUBELESS_JOURNAL_AGENT_STORE_REQUIRED",
      "Journaled agents require a native checkpoint-store handoff or explicit durability"
    );
  if (!scope(context)) return store;
  return {
    acquire: (key) =>
      withExecutionJournal(context, async () => {
        const lease = await store.acquire(key);
        return {
          read: () => withExecutionJournal(context, () => lease.read()),
          write: (value) => withExecutionJournal(context, () => lease.write(value)),
          close: () => withExecutionJournal(context, () => lease.close()),
        };
      }),
  };
}
