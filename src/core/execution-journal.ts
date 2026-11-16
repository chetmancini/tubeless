import type {
  PipelineContext,
  PipelineExecutionContext,
  PipelineExecutionJournal,
  PipelineDefinitionIdentity,
  PipelinePlan,
  PipelineRunControls,
} from "./pipeline-types.js";

const JOURNAL_SCOPE: unique symbol = Symbol("tubeless.executionJournal");
interface JournalScope {
  readonly session: JournalSession;
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

class JournalSession {
  failure?: JournalFailure;
  constructor(readonly journal: PipelineExecutionJournal) {}
  async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const failure = error instanceof JournalFailure ? error : new JournalFailure(error);
      this.failure ??= failure;
      throw failure;
    }
  }
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
  return current ? current.session.call(work) : work();
}

/** Each root invocation owns fresh failure state; children share it and extend only their path. */
export function enterExecutionJournal(context: PipelineContext, pipelineId: string): object {
  const journal = context.executionJournal;
  if (!journal) return {};
  const inherited = scope(context);
  const session = inherited?.session ?? new JournalSession(journal);
  const path = Object.freeze([
    ...(inherited?.path ?? ["v1", "execution", journal.key]),
    "pipeline",
    pipelineId,
  ]);
  return { [JOURNAL_SCOPE]: { session, path }, executionJournalPath: path };
}

/** The caller supplies an occurrence kind so an item key cannot alias an iteration or single child. */
export function inheritExecutionJournal<T extends PipelineContext>(
  context: PipelineExecutionContext<object>,
  target: T,
  occurrence: readonly string[],
  dryRun: boolean
): T {
  const inherited = scope(context);
  if (!dryRun && context.executionJournal && inherited) {
    target.executionJournal = context.executionJournal;
    Object.assign(target, {
      [JOURNAL_SCOPE]: {
        session: inherited.session,
        path: Object.freeze([...(context.executionJournalPath ?? inherited.path), ...occurrence]),
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
  await current.session.call(() =>
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
  await current.session.call(async () => {
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

export async function beginJournalStep(
  context: object,
  path: readonly string[],
  inputs: unknown,
  orchestration: boolean
): Promise<{ status: "new" | "incomplete" } | { status: "completed"; value: unknown } | undefined> {
  const current = scope(context);
  if (!current) return undefined;
  assertJournalHealthy(context);
  return current.session.call(async () => {
    const saved = await current.session.journal.begin(
      path,
      inputs,
      orchestration ? "orchestration" : "effect"
    );
    if (
      !saved ||
      !["new", "incomplete", "completed"].includes(saved.status) ||
      (saved.status === "completed" && !Object.hasOwn(saved, "value"))
    )
      throw journalError(
        "TUBELESS_JOURNAL_INVALID_RESPONSE",
        "Invalid execution journal begin response"
      );
    if (saved.status === "incomplete" && !orchestration)
      throw journalError(
        "TUBELESS_JOURNAL_OUTCOME_UNKNOWN",
        "An ordinary step was interrupted before completion acknowledgement; reconcile its effects before continuing"
      );
    return saved;
  });
}

export async function completeJournalStep(
  context: object,
  path: readonly string[],
  value: unknown
): Promise<void> {
  const current = scope(context);
  // Drain active effects even after a sibling fails; an acknowledged result remains recoverable.
  if (current) await current.session.call(() => current.session.journal.complete(path, value));
}

export function journalAgentStore(
  context: PipelineExecutionContext<object>,
  explicit?: PipelineExecutionJournal["agentStore"]
): NonNullable<PipelineExecutionJournal["agentStore"]> | undefined {
  const current = scope(context);
  if (!context.executionJournal || !current) return explicit;
  const store = explicit ?? context.executionJournal.agentStore;
  return {
    acquire: (key) =>
      current.session.call(async () => {
        if (!store)
          throw journalError(
            "TUBELESS_JOURNAL_AGENT_STORE_REQUIRED",
            "Journaled agents require a native checkpoint-store handoff or explicit durability"
          );
        const lease = await store.acquire(key);
        return {
          read: () => current.session.call(() => lease.read()),
          write: (value) => current.session.call(() => lease.write(value)),
          close: () => current.session.call(() => lease.close()),
        };
      }),
  };
}
