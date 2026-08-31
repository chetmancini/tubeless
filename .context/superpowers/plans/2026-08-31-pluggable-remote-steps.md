# Pluggable Remote Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `fromRemote` / `RemoteStepAdapter` so one in-process tubeless DAG can place opaque steps on other engines without teaching `executePlannedRun` about engines.

**Architecture:** Copy the `fromPipeline` factory/skippable/`buildStep`/`stepToPlanStep` pattern. Do **not** reuse `createSingleChildRunner`, `STEP_NESTED_PIPELINE`, or child-execution types. `fromRemote` builds an ordinary `AnyStep` whose `run` calls `mapInput` then `adapter.invoke`. A private `STEP_REMOTE` symbol carries `{ engine, target? }` for plan, render, traces, run-store, and studio. Dry-run stays a side-effect gate: omitting `dryRun` contacts the adapter with `context.dryRun === true`. The kernel does not inject `dryRun`, tail engine logs, or add `TUBELESS_REMOTE_*` codes. Adapters throw a plain `Error` (never `PipelineChildError` / `PipelineExecutionError`) so existing wrapping produces `TUBELESS_STEP_FAILED`.

**Tech Stack:** TypeScript, Vitest (`expectTypeOf` + `@ts-expect-error`), existing Standard Schema helper, no new npm dependencies, no Temporal/AWS SDKs.

**Spec:** [.context/superpowers/specs/2026-08-31-pluggable-remote-steps-design.md](../specs/2026-08-31-pluggable-remote-steps-design.md)

## Global Constraints

- Keep the kernel dependency-free. Engine SDKs stay in the app or a later optional package.
- `executePlannedRun` does not learn about engines. If a change there is needed, it is a bug in the factory design.
- No `engine` enum or switch on `AnyStep`.
- No `TUBELESS_REMOTE_*` codes. Adapter throws are `TUBELESS_STEP_FAILED`. Abort is `TUBELESS_RUN_CANCELLED`.
- Adapters must throw a plain `Error`. Do not throw `PipelineChildError` or `PipelineExecutionError` (those classify as `TUBELESS_CHILD_FAILED`).
- No engine job IDs on `PipelineStepReport`. Job ids may appear only in `context.log` or `reportProgress` `details`.
- No `streamLogs` flag, no kernel CloudWatch/Temporal tail, no flattening remote lines into child steps.
- Authors do not write `dryRun: "run"`. Omitting `dryRun` already means the work runs, including during a pipeline dry run. The factory must not stamp `"skip"`.
- `fromRemote` dry-run uses ordinary `StepDryRunPolicy` (`"skip" | preview handler`). Do not copy child-pipeline's skip-only `dryRun?: "skip"`.
- `mapInput` receives `PipelineStepContext<TOptions>` (has `reportProgress`). Do not copy `fromPipeline.mapOptions`, which takes `PipelineExecutionContext`.
- Do not add a `"rehearse"` plan value. JSON / `PipelinePlan` stay `dryRun` plus optional `remote`.
- Mermaid stays the parent-step graph. No remote node types.
- No `fromRemote` `mapResult`. No injected runner overrides.
- Tests use a fake adapter (`engine: "test"`). No AWS or Temporal dependency.
- A new agent-evaluation case is not required.
- After the public type export lands, run `bun run api:generate` in the same change.
- Linking `examples/remote-steps.ts` from `docs/recipes.md` **requires** a packed-example runner in `scripts/verify-packed-artifact.mjs`. `pack:verify` fails any recipes.md-linked `../examples/*.ts` without a runner.
- Do not run project-wide `make check` until the last task. Per-task commands are listed below.
- Single-file tests: `bun run test:run -- src/remote-step.test.ts` (optionally `-t "name"`). Public-entry tests import `"tubeless"` and need dist: `bun run test -- src/public-api.example.test.ts`.

## File structure

| File | Responsibility |
| --- | --- |
| `src/pipeline-types.ts` | `RemoteStepAdapter`; `PipelinePlanStep.remote` |
| `src/pipeline-plan.ts` | `STEP_REMOTE` symbol; `stepToPlanStep` copies it |
| `src/pipeline-steps.ts` | `fromRemote` / `fromRemote.skippable`; `AnyStep[STEP_REMOTE]` |
| `src/pipeline.ts` | Re-export `RemoteStepAdapter` |
| `src/render.ts` | Human plan suffix for `remote` |
| `src/tracing-internal.ts` | Serialize `remote` on `step.planned` |
| `src/run-store.ts` | Parse and retain `remote` on stored steps/definitions |
| `src/run-store-ui-page.ts` | "Remote step" kind, engine/target label |
| `src/remote-step.test.ts` | Kernel factory, dry-run, failure, log, abort, type tests |
| `src/render.test.ts` | Human plan text for remote steps |
| `src/tracing.test.ts` | `step.planned` includes `remote` |
| `src/run-store.test.ts` | Projector keeps `remote` |
| `src/run-store-ui.test.ts` | Studio page source mentions `step.remote` |
| `src/public-api.example.test.ts` | One `fromRemote` smoke through `tubeless` |
| `examples/remote-steps.ts` | Compiled recipe; export `runRemoteStepsExample` |
| `examples/catalog/pipelines/enrich.ts` | Catalog pipeline |
| `examples/catalog/scripts/enrich.ts` | Catalog command |
| `examples/catalog/tubeless.studio.ts` | Register the command |
| `docs/remote-step-composition.md` | Living contract |
| `scripts/verify-packed-artifact.mjs` | Packed runner + packed-file list |
| `docs/recipes.md`, `docs/agent-guide.md`, `docs/comparison.md`, `docs/concepts.md`, `docs/README.md`, `docs/llms.txt` | Learning surface |

`skills/tubeless/SKILL.md` already defers to the agent guide. Do not add a second copy of the rules.

---

### Task 1: `fromRemote` factory, types, and plan metadata

**Files:**
- Create: `src/remote-step.test.ts`
- Modify: `src/pipeline-types.ts` (add `RemoteStepAdapter` next to `PipelineStepContext`; add `remote?` on `PipelinePlanStep` after `nestedPipeline`)
- Modify: `src/pipeline-plan.ts` (export `STEP_REMOTE` next to `STEP_NESTED_PIPELINE`; copy it in `stepToPlanStep`)
- Modify: `src/pipeline-steps.ts` (symbol on `AnyStep`; factory methods; attach constructors)
- Modify: `src/pipeline.ts` (export `RemoteStepAdapter` in the existing `pipeline-types` type export list)

**Interfaces:**
- Consumes: `createSteps`, `definePipeline`, `stepToPlanStep`, existing `dryRun` / `skip` / `outputSchema` / `toPipelineError` behavior. Do not change `executePlannedRun`. Do not import `child-execution.ts`.
- Produces:

```ts
export interface RemoteStepAdapter<TOptions extends object, TPayload, TResult> {
  /** Presentation only. The kernel never switches on this. */
  readonly engine: string;
  /** Function name, workflow type, URL, queue. Presentation only. */
  readonly target?: string;
  invoke(
    payload: TPayload,
    context: PipelineStepContext<TOptions>
  ): Promise<TResult>;
}

// On PipelinePlanStep, after nestedPipeline:
remote?: { engine: string; target?: string };

// On StepFactory:
fromRemote: FromRemoteConstructor<TOptions, TInputOptions>;
```

`fromRemote` required fields: `adapter`, `mapInput`, `outputSchema`. Optional: `dependsOn` / `optionalDependsOn` / `skipAfterFailureOf` / `name` / `description` / `dryRun` (`StepDryRunPolicy`). Non-skippable overload has `skip?: never`. `fromRemote.skippable` requires `skip` and widens `TOut | undefined`.

`STEP_REMOTE` is `Symbol("tubeless.stepRemote")`, not a public export. Do not re-export it from `pipeline.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/remote-step.test.ts`. Copy the `standardSchema` helper from `src/pipeline.test.ts:48-53`. Pattern the cases after `src/child-pipeline.test.ts` (plan 870-895, dry-run 897-927, throw 929-971, cause 1006-1046, skippable types 588-645). Do not implement `fromRemote` yet.

```ts
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  defaultPipelineContext,
  definePipeline,
  type RemoteStepAdapter,
  type StandardSchemaV1,
  type Step,
} from "./pipeline";
import type { PipelineTraceEvent } from "./tracing.js";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"],
  vendor = "test"
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor, version: 1 } };
}

const resultSchema = standardSchema<{ ok: true }, { ok: true }>((value) => {
  if (
    value &&
    typeof value === "object" &&
    "ok" in value &&
    (value as { ok: unknown }).ok === true
  ) {
    return { value: value as { ok: true } };
  }
  return { issues: [{ message: "expected { ok: true }" }] };
});

function testAdapter<TPayload, TResult>(
  invoke: RemoteStepAdapter<object, TPayload, TResult>["invoke"],
  target = "enrich-v2"
): RemoteStepAdapter<object, TPayload, TResult> {
  return { engine: "test", target, invoke };
}

describe("fromRemote", () => {
  it("copies adapter engine and target onto the parent plan without flattening", () => {
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(async () => ({ ok: true })),
      mapInput: () => ({ rows: [] }),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-plan",
      steps: [enrich],
      finalize: () => undefined,
    });

    const plan = pipeline.plan({});
    expect(plan.steps[0]?.remote).toEqual({ engine: "test", target: "enrich-v2" });
    expect(plan.steps[0]?.nestedPipeline).toBeUndefined();
    expect(plan.steps[0]?.dryRun).toBe("run");
  });

  it("contacts the adapter during a pipeline dry run when dryRun is omitted", async () => {
    const invoke = vi.fn(async (_payload: { dryRun: boolean }, context) => {
      expect(context.dryRun).toBe(true);
      return { ok: true as const };
    });
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(invoke),
      mapInput: (_inputs, ctx) => ({ dryRun: ctx.dryRun }),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-rehearse",
      steps: [enrich],
      finalize: () => undefined,
    });

    const result = await pipeline.run({ dryRun: true });
    expect(result.status).toBe("completed");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toEqual({ dryRun: true });
  });

  it("does not call invoke when dryRun is skip", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const }));
    const step = createSteps();
    const charge = step.fromRemote("charge", {
      adapter: testAdapter(invoke, "chargeOrder"),
      mapInput: () => ({ orderId: "1" }),
      outputSchema: resultSchema,
      dryRun: "skip",
    });
    const pipeline = definePipeline({
      id: "remote-skip",
      steps: [charge],
      finalize: () => undefined,
    });

    const result = await pipeline.run({ dryRun: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.steps[0]).toMatchObject({ status: "skipped", reason: "dry-run" });
    expect(pipeline.plan({ dryRun: true }).steps[0]).toMatchObject({
      dryRun: "skip",
      remote: { engine: "test", target: "chargeOrder" },
    });
  });

  it("does not call invoke when a preview handler is present", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const }));
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(invoke),
      mapInput: () => ({ rows: [] }),
      outputSchema: resultSchema,
      dryRun: () => ({ ok: true as const }),
    });
    const pipeline = definePipeline({
      id: "remote-preview",
      steps: [enrich],
      finalize: () => undefined,
    });

    const result = await pipeline.run({ dryRun: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(pipeline.plan({ dryRun: true }).steps[0]?.dryRun).toBe("custom");
  });

  it("classifies adapter throws as ordinary step failures", async () => {
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(async () => {
        throw new Error("lambda timeout");
      }),
      mapInput: () => ({}),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-throw",
      steps: [enrich],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "lambda timeout",
      phase: "execution",
      stepId: "enrich",
    });
  });

  it("keeps a thrown cause and code on TUBELESS_STEP_FAILED", async () => {
    const remote = Object.assign(new Error("activity failed"), { code: "ACTIVITY_FAILED" });
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(async () => {
        throw Object.assign(new Error("workflow failed"), {
          cause: remote,
          code: "WORKFLOW_FAILED",
        });
      }),
      mapInput: () => ({}),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-cause",
      steps: [enrich],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});
    expect(result.errors[0]).toMatchObject({
      cause: {
        message: "activity failed",
        sourceCode: "ACTIVITY_FAILED",
      },
      code: "TUBELESS_STEP_FAILED",
      sourceCode: "WORKFLOW_FAILED",
      stepId: "enrich",
    });
  });

  it("forwards context.log from invoke to the injected logger and pipeline.log", async () => {
    const log = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
    const events: PipelineTraceEvent[] = [];
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(async (_payload, context) => {
        context.log.log("remote line", 12);
        return { ok: true as const };
      }),
      mapInput: () => ({}),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-log",
      steps: [enrich],
      finalize: () => undefined,
    });

    await pipeline.run(
      {},
      {
        ...defaultPipelineContext(),
        log,
        tracing: {
          exporter: { export: (event) => events.push(event), flush: async () => undefined },
        },
      }
    );

    expect(log.log).toHaveBeenCalledWith("remote line", 12);
    expect(events.some((event) => event.name === "pipeline.log" && event.stepId === "enrich")).toBe(
      true
    );
  });

  it("classifies abort during invoke as cancellation", async () => {
    const controller = new AbortController();
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(
        (_payload, context) =>
          new Promise((_resolve, reject) => {
            const fail = () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (context.signal.aborted) fail();
            else context.signal.addEventListener("abort", fail, { once: true });
          })
      ),
      mapInput: () => ({}),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-abort",
      steps: [enrich],
      finalize: () => undefined,
    });

    const pending = pipeline.run({}, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      stepId: "enrich",
    });
  });

  it("requires outputSchema and keeps skip / dryRun tokens off the authoring surface", () => {
    const step = createSteps();
    const adapter = testAdapter(async (payload: { n: number }) => payload);
    const schema = standardSchema<{ n: number }, { n: number }>((value) => ({
      value: value as { n: number },
    }));

    const remote = step.fromRemote("enrich", {
      adapter,
      mapInput: () => ({ n: 1 }),
      outputSchema: schema,
    });
    expectTypeOf(remote).toEqualTypeOf<
      Step<"enrich", { n: number }, object, object, { n: number }>
    >();

    const skippable = step.fromRemote.skippable("maybe-enrich", {
      adapter,
      mapInput: () => ({ n: 1 }),
      outputSchema: schema,
      skip: () => "disabled",
    });
    expectTypeOf(skippable).toEqualTypeOf<
      Step<"maybe-enrich", { n: number } | undefined, object, object, { n: number }>
    >();

    const dependent = step("after", {
      dependsOn: [skippable],
      run: (inputs) => {
        expectTypeOf(inputs["maybe-enrich"]).toEqualTypeOf<{ n: number } | undefined>();
        return inputs["maybe-enrich"]?.n ?? 0;
      },
    });
    expectTypeOf(dependent).toEqualTypeOf<Step<"after", number, object>>();

    step.fromRemote("missing-schema", {
      adapter,
      mapInput: () => ({ n: 1 }),
      // @ts-expect-error outputSchema is required
    });

    step.fromRemote("skip-requires-skippable", {
      adapter,
      mapInput: () => ({ n: 1 }),
      outputSchema: schema,
      // @ts-expect-error Policy skip belongs on fromRemote.skippable.
      skip: () => "disabled",
    });

    step.fromRemote("dry-run-run-is-invalid", {
      adapter,
      mapInput: () => ({ n: 1 }),
      outputSchema: schema,
      // @ts-expect-error Authors do not write dryRun: "run".
      dryRun: "run",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:run -- src/remote-step.test.ts`

Expected: FAIL because `fromRemote` and `RemoteStepAdapter` do not exist (`Property 'fromRemote' does not exist` and/or type export missing). If the file fails to parse for an unrelated reason, fix only the test file and re-run until the failure is the missing factory.

- [ ] **Step 3: Write the minimal kernel implementation**

In `src/pipeline-types.ts`, add the adapter next to the other public context types, and add `remote` on `PipelinePlanStep` after `nestedPipeline` (`src/pipeline-types.ts:394-400`):

```ts
export interface RemoteStepAdapter<TOptions extends object, TPayload, TResult> {
  readonly engine: string;
  readonly target?: string;
  invoke(payload: TPayload, context: PipelineStepContext<TOptions>): Promise<TResult>;
}
```

```ts
  remote?: {
    engine: string;
    target?: string;
  };
```

In `src/pipeline-plan.ts`, next to `STEP_NESTED_PIPELINE` (`src/pipeline-plan.ts:24`):

```ts
export const STEP_REMOTE: unique symbol = Symbol("tubeless.stepRemote");
```

In `stepToPlanStep` (`src/pipeline-plan.ts:307-312`), after the nested copy:

```ts
  if (step[STEP_REMOTE]) {
    planStep.remote = { ...step[STEP_REMOTE] };
  }
```

In `src/pipeline-steps.ts`:

1. Import `STEP_REMOTE` from `./pipeline-plan.js` (already imports `STEP_NESTED_PIPELINE`) and `RemoteStepAdapter` from `./pipeline-types.js`.
2. Add `readonly [STEP_REMOTE]?: NonNullable<PipelinePlanStep["remote"]>;` on `AnyStep` next to `[STEP_NESTED_PIPELINE]` (`src/pipeline-steps.ts:41`).
3. Add definition + constructor types next to `FromPipelineConstructor`. Mirror skippable widening (`src/pipeline-steps.ts:349-385`) but require `outputSchema` and use `mapInput` + `StepDryRunPolicy`. There is no `mapResult`.
4. Implement `fromRemote` inside `createStepFactory` as a closure, same attach pattern as `fromPipeline` (`src/pipeline-steps.ts:468-525`, `571-581`):

```ts
  const fromRemote = ((
    id: string,
    config: {
      adapter: RemoteStepAdapter<object, unknown, unknown>;
      mapInput: (
        inputs: Record<string, unknown>,
        context: PipelineStepContext<TOptions>
      ) => unknown;
      outputSchema: StandardSchemaV1;
      dependsOn?: readonly AnyStep<TOptions>[];
      optionalDependsOn?: readonly AnyStep<TOptions>[];
      skipAfterFailureOf?: readonly AnyStep<TOptions>[];
      name?: string;
      description?: string;
      dryRun?: "skip" | AnyStepDryRunHandler<TOptions>;
      skip?: StepSkipPredicate<
        TOptions,
        readonly AnyStep<TOptions>[],
        readonly AnyStep<TOptions>[],
        unknown
      >;
    }
  ) => {
    const remote: NonNullable<PipelinePlanStep["remote"]> = { engine: config.adapter.engine };
    if (config.adapter.target !== undefined) remote.target = config.adapter.target;
    const definition = {
      [STEP_REMOTE]: remote,
      dependsOn: config.dependsOn,
      optionalDependsOn: config.optionalDependsOn,
      skipAfterFailureOf: config.skipAfterFailureOf,
      name: config.name,
      description: config.description,
      dryRun: config.dryRun,
      outputSchema: config.outputSchema,
      run: (inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>) =>
        config.adapter.invoke(config.mapInput(inputs, context), context),
    };
    if ("skip" in config && config.skip !== undefined) {
      const skip = config.skip;
      return buildStep(id, {
        ...definition,
        skip: (inputs, context) => skip(inputs as never, context),
      });
    }
    return buildStep(id, definition);
  }) as StepFactory<TOptions, TInputOptions>["fromRemote"];
```

5. Attach it on the factory next to `fromPipeline`:

```ts
  const factory = Object.assign(buildStep, {
    skippable: buildStep,
    fromPipeline,
    fromRemote,
    forEachPipeline,
  }) as StepFactory<TOptions, TInputOptions>;
  factory.fromPipeline.skippable = fromPipeline as StepFactory<
    TOptions,
    TInputOptions
  >["fromPipeline"]["skippable"];
  factory.fromRemote.skippable = fromRemote as StepFactory<
    TOptions,
    TInputOptions
  >["fromRemote"]["skippable"];
```

6. Do **not** stamp `dryRun: "skip"`. Do **not** wrap `invoke` errors. Do **not** put `dryRun` into the payload. Do **not** set both `STEP_REMOTE` and `STEP_NESTED_PIPELINE`. Do **not** call `createSingleChildRunner`.

In `src/pipeline.ts`, add `RemoteStepAdapter` to the `export type { ... } from "./pipeline-types.js"` list (`src/pipeline.ts:38-88`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:run -- src/remote-step.test.ts`

Expected: PASS. If a type test fails, fix the constructor overloads (required `outputSchema`, `skip?: never` on the non-skippable overload, `dryRun` is `StepDryRunPolicy` so `"run"` is rejected). If abort is misclassified, throw an `AbortError` from the adapter when `context.signal.aborted` is true — do not add a remote-specific code. If the throw is `TUBELESS_CHILD_FAILED`, the adapter or factory is throwing a child/execution error; throw a plain `Error`.

- [ ] **Step 5: Commit**

```bash
git add src/remote-step.test.ts src/pipeline-types.ts src/pipeline-plan.ts src/pipeline-steps.ts src/pipeline.ts
git commit -m "Add fromRemote for opaque mixed-engine steps."
```

---

### Task 2: Plan, trace, store, and studio presentation

**Files:**
- Modify: `src/render.ts` (`renderPipelinePlan` human branch at `src/render.ts:83-87`)
- Modify: `src/render.test.ts` (next to child-pipeline case at `src/render.test.ts:70-83`)
- Modify: `src/tracing-internal.ts` (`serializeNestedPipeline` at 85-93; `step.planned` attributes at 210-221)
- Modify: `src/tracing.test.ts` (copy exporter pattern from 55-68; nested lock at 217-228)
- Modify: `src/run-store.ts` (`StoredPipelineStep` 65-73, `StoredPipelineDefinitionStep` 103-113, `parseNestedPipeline` 230-263, `applyRunEvent` 338-343, `definitionStep` 461-476, `cloneStep` 411-422, `cloneDefinitionStep` 517-527)
- Modify: `src/run-store.test.ts` (next to nested projector at 196-234)
- Modify: `src/run-store-ui-page.ts` (`stepRow` 549-561, `renderPlan` 724-734)
- Modify: `src/run-store-ui.test.ts` (standalone interface test at 187)

**Interfaces:**
- Consumes: `PipelinePlanStep.remote` from Task 1; existing `nested_pipeline` serialize/parse/clone path.
- Produces: human plan suffix; trace attribute `remote` (JSON string `{ engine, target? }`); stored `remote?: { engine: string; target?: string }` on run steps and definition steps; studio kind `"Remote step"`.

Do not add Mermaid node types. Do not add a `"rehearse"` plan enum. JSON `renderPipelinePlan(plan, { format: "json" })` already dumps the plan object.

- [ ] **Step 1: Write the failing observation tests**

Add to `src/render.test.ts` next to the child-pipeline case. Reuse `createSteps` / `definePipeline` / `renderPipelinePlan` already imported in that file. Add a tiny local schema helper if needed:

```ts
  it("identifies remote steps and says when a dry run contacts the engine", () => {
    const schema = {
      "~standard": {
        validate: () => ({ value: { ok: true as const } }),
        vendor: "test",
        version: 1 as const,
      },
    };
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: { engine: "lambda", target: "enrich-v2", invoke: async () => ({ ok: true as const }) },
      mapInput: () => ({}),
      outputSchema: schema,
    });
    const charge = step.fromRemote("charge", {
      adapter: {
        engine: "temporal",
        target: "chargeOrder",
        invoke: async () => ({ ok: true as const }),
      },
      mapInput: () => ({}),
      outputSchema: schema,
      dryRun: "skip",
    });
    const pipeline = definePipeline({
      id: "remote-render",
      steps: [enrich, charge],
      finalize: () => undefined,
    });

    const dry = pipeline.plan({ dryRun: true });
    const rendered = renderPipelinePlan(dry);
    expect(dry.steps[0]?.remote).toEqual({ engine: "lambda", target: "enrich-v2" });
    expect(rendered).toContain("enrich: run -> remote lambda (enrich-v2); dry-run contacts engine");
    expect(rendered).toContain("charge: skip: dry-run -> remote temporal (chargeOrder)");

    const live = renderPipelinePlan(pipeline.plan({}));
    expect(live).toContain("enrich: run -> remote lambda (enrich-v2)");
    expect(live).not.toContain("dry-run contacts engine");
  });
```

In `src/tracing.test.ts`, add a case that builds one `fromRemote` step, runs with a capturing exporter (pattern at `src/tracing.test.ts:55-68`), and asserts the parent `step.planned` event has `attributes.remote` equal to `JSON.stringify({ engine: "test", target: "enrich-v2" })`. Do not flatten remote ids into descendant runs.

In `src/run-store.test.ts`, next to the nested-pipeline projector test (`src/run-store.test.ts:196-234`), add:

```ts
  it("retains remote metadata from step.planned on runs and definitions", () => {
    const remote = { engine: "lambda", target: "enrich-v2" };
    const snapshot = projectPipelineRunStore([
      event(1, "pipeline.started", { attributes: { target_ids: "[]" } }),
      event(2, "step.planned", {
        attributes: {
          dependencies: "[]",
          dry_run: "run",
          optional_dependencies: "[]",
          remote: JSON.stringify(remote),
          runtime_skip_possible: false,
          skip_after_failure_of: "[]",
        },
        stepId: "enrich",
      }),
      event(3, "step.running", { attemptId: "attempt-1", stepId: "enrich" }),
      event(4, "step.complete", { attemptId: "attempt-1", stepId: "enrich" }),
    ]);

    expect(snapshot.runs[0]?.steps[0]).toMatchObject({ id: "enrich", remote, status: "completed" });
    expect(snapshot.definitions[0]?.steps[0]).toMatchObject({ id: "enrich", remote });
  });
```

Use the existing `event` / `projectPipelineRunStore` helpers in that file.

In `src/run-store-ui.test.ts`, in the standalone interface test that already asserts `expect(html).toContain("step.nestedPipeline")` (`src/run-store-ui.test.ts:187`), add:

```ts
    expect(html).toContain("step.remote");
    expect(html).toContain("Remote step");
```

- [ ] **Step 2: Run the observation tests to verify they fail**

```bash
bun run test:run -- src/render.test.ts src/tracing.test.ts src/run-store.test.ts src/run-store-ui.test.ts
```

Expected: FAIL on the new assertions (render text missing, `remote` attribute absent, stored `remote` undefined, HTML missing `step.remote` / `Remote step`). Existing nested-pipeline tests must still pass.

- [ ] **Step 3: Implement presentation**

`src/render.ts` — inside the human branch of `renderPipelinePlan`, after the `nested` suffix (`src/render.ts:83-87`):

```ts
function describeRemote(step: PipelinePlanStep, planDryRun: boolean): string {
  if (!step.remote) return "";
  const target = step.remote.target ? ` (${step.remote.target})` : "";
  const label = `remote ${step.remote.engine}${target}`;
  const contactsEngine =
    planDryRun && step.dryRun === "run" && step.selected && step.skipReason === undefined;
  return contactsEngine ? ` -> ${label}; dry-run contacts engine` : ` -> ${label}`;
}
```

Compose it after `nested` so a step still cannot be both (factory never sets both symbols). The skip disposition is already `skip: dry-run`; the suffix supplies ` -> remote temporal (chargeOrder)`.

`src/tracing-internal.ts` — next to `serializeNestedPipeline` (`src/tracing-internal.ts:85-93`):

```ts
function serializeRemote(remote: PipelinePlanStep["remote"]): string | undefined {
  if (!remote) return undefined;
  return JSON.stringify({
    engine: boundTraceString(remote.engine),
    ...(remote.target ? { target: boundTraceString(remote.target) } : {}),
  });
}
```

Add `remote: serializeRemote(event.step.remote)` to the `step.planned` attributes next to `nested_pipeline` (`src/tracing-internal.ts:215`).

`src/run-store.ts`:

1. Add `export interface StoredRemote { engine: string; target?: string }` next to `StoredNestedPipeline` (`src/run-store.ts:40-45`).
2. Add `remote?: StoredRemote` to `StoredPipelineStep` and `StoredPipelineDefinitionStep`.
3. Add `parseRemote` mirroring `parseNestedPipeline` (`src/run-store.ts:230-263`): read attribute `"remote"`, require a non-empty string `engine`, optional string `target`, slice strings to 4_096.
4. In `applyRunEvent` for `step.planned` (`src/run-store.ts:338-343`): `const remote = parseRemote(event.attributes); if (remote) step.remote = remote;`
5. Same in `definitionStep` (`src/run-store.ts:474-475`).
6. Clone `remote` in `cloneStep` and `cloneDefinitionStep`: `if (step.remote) cloned.remote = { ...step.remote };`

`src/run-store-ui-page.ts` — in both `stepRow` (549-561) and `renderPlan` (730-733):

```js
      const remote = step.remote;
      const kind = remote ? 'Remote step' : nested ? (nested.mode === 'for-each' ? 'Pipeline fan-out' : 'Nested pipeline') : 'Step';
      const remoteDetail = remote ? '<div class="plan-nested"><strong>' + esc(remote.engine) + '</strong>' + (remote.target ? '<span>' + esc(remote.target) + '</span>' : '') + '</div>' : '';
```

Use `kind` in the existing `plan-kind` span. Include `remoteDetail` next to `nestedDetail` in both places. A step with `remote` is not a nested pipeline; do not also show declared-step chips. Do not flatten a remote graph. Do not add a new CSS layout system.

- [ ] **Step 4: Run the observation tests to verify they pass**

```bash
bun run test:run -- src/render.test.ts src/tracing.test.ts src/run-store.test.ts src/run-store-ui.test.ts src/remote-step.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/render.test.ts src/tracing-internal.ts src/tracing.test.ts src/run-store.ts src/run-store.test.ts src/run-store-ui-page.ts src/run-store-ui.test.ts
git commit -m "Show remote step engine and target in plan, traces, and studio."
```

---

### Task 3: Public export inventory and package-entry smoke

**Files:**
- Modify: `src/public-api.example.test.ts` (child smoke at 53-62 / 123-127)
- Modify: `docs/api-reference.md` and `docs/api-report.json` via `bun run api:generate` (do not hand-edit)

**Interfaces:**
- Consumes: `fromRemote`, `RemoteStepAdapter` exported from `tubeless` (Task 1 already added the type to `src/pipeline.ts`).
- Produces: one package-entry smoke; regenerated API inventory that lists `RemoteStepAdapter` and `StepFactory.fromRemote`.

- [ ] **Step 1: Write the failing public-API smoke**

In `src/public-api.example.test.ts`, add `type RemoteStepAdapter` to the existing `"tubeless"` import. After the `forEachPipeline` fixtures, add:

```ts
const enrichSchema = {
  "~standard": {
    validate: (value: unknown) =>
      value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === true
        ? { value: value as { ok: true } }
        : { issues: [{ message: "ok" }] },
    vendor: "test",
    version: 1 as const,
  },
};

const remoteStep = createSteps<ImportOptions>();
const remoteAdapter: RemoteStepAdapter<ImportOptions, { lines: readonly string[] }, { ok: true }> = {
  engine: "test",
  target: "enrich-v2",
  invoke: async (payload) => ({ ok: payload.lines.length >= 0 }),
};
const remoteEnrich = remoteStep.fromRemote("remote-enrich", {
  adapter: remoteAdapter,
  mapInput: (_inputs, context) => ({ lines: context.options.lines, dryRun: context.dryRun }),
  outputSchema: enrichSchema,
});
const RemotePipeline = definePipeline({
  id: "remote-enrich",
  steps: [remoteEnrich],
  finalize: (outputs) => outputs["remote-enrich"],
});
```

And a test next to the child smoke:

```ts
  it("composes a remote step through the package entrypoint", async () => {
    const value = await RemotePipeline.runOrThrow({ lines: ["alpha"] });
    expect(value).toEqual({ ok: true });
    expect(RemotePipeline.plan({}).steps[0]?.remote).toEqual({
      engine: "test",
      target: "enrich-v2",
    });
  });
```

- [ ] **Step 2: Run the public-API test**

This file imports `"tubeless"` (needs dist). Run: `bun run test -- src/public-api.example.test.ts`

Expected: FAIL if `RemoteStepAdapter` is not exported from the package entry, or if `fromRemote` is missing on the factory type. If Task 1 already exported it but dist is stale, the build in `bun run test` refreshes it. If it passes immediately, you skipped writing the test first — add the test, watch it fail on a missing `RemotePipeline`, then add the fixture.

- [ ] **Step 3: Regenerate the API inventory**

Run: `bun run api:generate`

Confirm `docs/api-reference.md` and `docs/api-report.json` now mention `RemoteStepAdapter` and `fromRemote`. If a symbol is missing, the export list in `src/pipeline.ts` is incomplete.

- [ ] **Step 4: Re-run the smoke and API check**

```bash
bun run test -- src/public-api.example.test.ts
bun run api:check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/public-api.example.test.ts docs/api-reference.md docs/api-report.json
git commit -m "Export RemoteStepAdapter and smoke fromRemote through the package entry."
```

---

### Task 4: Compiled recipe, catalog, learning surface, and packed runner

**Files:**
- Create: `examples/remote-steps.ts`
- Create: `examples/catalog/pipelines/enrich.ts`
- Create: `examples/catalog/scripts/enrich.ts`
- Create: `docs/remote-step-composition.md`
- Modify: `examples/catalog/tubeless.studio.ts`
- Modify: `docs/recipes.md` (table after child-pipeline row L16; selection rules after L36-39)
- Modify: `docs/agent-guide.md` (after `fromPipeline` bullet L37-40)
- Modify: `docs/comparison.md` (after L45-47)
- Modify: `docs/concepts.md` (after Child pipelines L409-415)
- Modify: `docs/README.md` (Deeper reference L26)
- Modify: `docs/llms.txt` (Advanced L47; examples L60)
- Modify: `scripts/verify-packed-artifact.mjs` (runners map ~160-230; packed file list ~264-281)
- Do not edit `skills/tubeless/SKILL.md`

**Interfaces:**
- Consumes: public `fromRemote` / `RemoteStepAdapter` from Task 3.
- Produces: a compiled recipe matching the spec's parse / enrich / charge example; a catalog-shaped pipeline + command; docs that state the inverse dry-run contract and the two compositions; a packed-example runner so `pack:verify` does not fail the new recipes.md link.

- [ ] **Step 1: Write the example so typecheck fails until it compiles**

Create `examples/remote-steps.ts` following `examples/child-pipeline.ts` (export a pipeline + `runRemoteStepsExample()`, plus a `if (false)` `@ts-expect-error` for `dryRun: "run"`):

```ts
import { createSteps, definePipeline, type RemoteStepAdapter, type StandardSchemaV1 } from "tubeless";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"]
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor: "example", version: 1 } };
}

interface ParseResult {
  readonly rows: readonly string[];
}

interface EnrichResult {
  readonly orderId: string;
  readonly rows: readonly string[];
}

interface ChargeResult {
  readonly charged: true;
  readonly orderId: string;
}

const parseSchema = standardSchema<ParseResult, ParseResult>((value) => ({
  value: value as ParseResult,
}));
const enrichSchema = standardSchema<EnrichResult, EnrichResult>((value) => ({
  value: value as EnrichResult,
}));
const chargeSchema = standardSchema<ChargeResult, ChargeResult>((value) => ({
  value: value as ChargeResult,
}));

interface RemoteStepsOptions {
  lines: readonly string[];
}

const step = createSteps<RemoteStepsOptions>();

const parse = step("parse", {
  outputSchema: parseSchema,
  run: (_inputs, context) => ({
    rows: context.options.lines.map((line) => line.trim()).filter((line) => line.length > 0),
  }),
});

const enrichAdapter: RemoteStepAdapter<
  RemoteStepsOptions,
  { dryRun: boolean; rows: readonly string[]; runId: string },
  EnrichResult
> = {
  engine: "lambda",
  target: "enrich-v2",
  invoke: async (payload, context) => {
    context.log.log("rehearsing enrich", payload.rows.length);
    return { orderId: "order-1", rows: payload.rows };
  },
};

const enrich = step.fromRemote("enrich", {
  dependsOn: [parse],
  adapter: enrichAdapter,
  mapInput: ({ parse }, ctx) => ({
    rows: parse.rows,
    runId: ctx.runId,
    dryRun: ctx.dryRun,
  }),
  outputSchema: enrichSchema,
});

const chargeAdapter: RemoteStepAdapter<RemoteStepsOptions, { orderId: string }, ChargeResult> = {
  engine: "temporal",
  target: "chargeOrder",
  invoke: async (payload) => ({ charged: true, orderId: payload.orderId }),
};

const charge = step.fromRemote("charge", {
  dependsOn: [enrich],
  adapter: chargeAdapter,
  mapInput: ({ enrich }) => ({ orderId: enrich.orderId }),
  outputSchema: chargeSchema,
  dryRun: "skip",
});

export const RemoteStepsPipeline = definePipeline({
  id: "remote-steps",
  steps: [parse, enrich, charge],
  targets: [charge],
  finalize: (outputs) => ({
    charged: outputs.charge?.charged === true,
    orderId: outputs.enrich?.orderId,
    rows: outputs.parse?.rows ?? [],
  }),
});

export async function runRemoteStepsExample() {
  return RemoteStepsPipeline.runOrThrow({ lines: [" Alpha ", "", "Beta"] });
}

if (false) {
  step.fromRemote("invalid-dry-run-run", {
    adapter: enrichAdapter,
    mapInput: () => ({ dryRun: false, rows: [], runId: "x" }),
    outputSchema: enrichSchema,
    // @ts-expect-error Authors do not write dryRun: "run".
    dryRun: "run",
  });
}
```

Create `examples/catalog/pipelines/enrich.ts` with kebab-case ids (`parse-rows`, `enrich-rows`, `charge-order`), a fake `engine: "test"` adapter, `export const EnrichPipeline`, and the same omit / `dryRun: "skip"` pair. Catalog files import from `"tubeless"` like `examples/catalog/pipelines/import.ts`.

Create `examples/catalog/scripts/enrich.ts`. Copy a working param from the packed fixture in `scripts/verify-packed-artifact.mjs` (`type: "string"`), not a new CLI type:

```ts
import { definePipelineCommand } from "tubeless/cli";
import { EnrichPipeline } from "../pipelines/enrich.ts";

export const EnrichCommand = definePipelineCommand(EnrichPipeline, {
  description: "Parse locally, rehearse a remote enrich, and skip remote charge on dry-run.",
  params: {
    lines: {
      type: "string",
      description: "Comma-separated rows to parse.",
    },
  },
  mapOptions: (args) => ({
    lines: String(args.lines)
      .split(",")
      .map((line) => line.trim()),
  }),
  summarize: (result) => [`Enriched ${result.rows.length} row(s).`],
});

if (import.meta.main) {
  void EnrichCommand.main();
}
```

If `EnrichPipeline` finalize does not expose `rows`, match the summarize field to the actual result. Copy `if (import.meta.main)` from `examples/catalog/scripts/import.ts`.

Register it in `examples/catalog/tubeless.studio.ts`:

```ts
    { file: "./scripts/enrich.ts", export: "EnrichCommand", name: "Enrich rows" },
```

Keep the existing `--step/--target` vs `stepIds` / `targets` comment. Do not infer the command from run history.

- [ ] **Step 2: Typecheck the examples**

Run: `bun run typecheck:run`

Expected after the files exist: PASS for examples if `fromRemote` is exported (examples import `"tubeless"`, so run `bun run build` first if dist is stale: `bun run typecheck`). If a catalog param type is wrong, fix the command to match a working `type: "string"` param. Do not add a new CLI flag.

- [ ] **Step 3: Write the living contract, learning-surface rows, and packed runner**

Create `docs/remote-step-composition.md` in the same role as `docs/child-pipeline-composition.md`. Required sections:

1. **What ships** — `fromRemote` / `fromRemote.skippable` / `RemoteStepAdapter`. One opaque parent step. `executePlannedRun` unchanged.
2. **Two compositions** — spec table: host embed (`pipeline.runOrThrow` + `runId` / `parentRunId`) vs `fromRemote`. Complementary, not crash-resume.
3. **Adapter mapping** — `signal`, `reportProgress`, optional `context.log`, `dryRun`, rethrow `Error` with `cause` / `code`. No `stepId` on `PipelineStepContext`; job ids come from the `fromRemote("id", …)` call site via `mapInput`.
4. **Inverse dry-run contract** — omit contacts the engine with `context.dryRun === true`; `dryRun: "skip"` does not call `invoke`; a preview handler stays local. Kernel does not inject `dryRun`. Authors put `dryRun: ctx.dryRun` in `mapInput`.
5. **Local visibility** — logs optional, exceptions required, progress vs logs, no `streamLogs`, no `TUBELESS_REMOTE_*`.
6. **Non-goals** — placement driver, official SDKs, flattening, injected runner overrides, `mapResult`.

`docs/recipes.md` — add two rows to the intent table after the child-pipeline row (L16):

| Mixed local and remote steps | [`remote-steps.ts`](../../../examples/remote-steps.ts) | `fromRemote`, `RemoteStepAdapter`, inverse dry-run |
| Host a pipeline in a durable engine | [`remote-steps.ts`](../../../examples/remote-steps.ts) | `runOrThrow`, pass `runId` / `parentRunId` |

Add a selection rule after rule 5 (forEachPipeline, L38-39):

```
Use fromRemote when a unit of work lives on another engine but the parent
DAG still runs in this process. Omit dryRun only when the adapter and the
remote worker are side-effect free under context.dryRun. Embed the whole
pipeline in Temporal/Lambda/a worker when the graph must outlive the process.
```

`docs/agent-guide.md` primitive list, after the `fromPipeline` bullet (L37-40):

```
- Use `fromRemote` for a unit of work that lives on another engine. Required
  fields are `adapter`, `mapInput`, and `outputSchema`. Omitting `dryRun`
  contacts the engine during a pipeline dry run; the adapter and remote
  worker must honor `context.dryRun` and authors prove the flag crossed the
  boundary in `mapInput`. Host-embed with `pipeline.runOrThrow` and pass
  `runId` / `parentRunId` when the graph must outlive the process. Parent
  plans expose `remote` with `engine` and optional `target`. Adapters may
  forward remote lines through `context.log` and must rethrow remote
  failures as `Error` with `cause` / `code`.
```

`docs/comparison.md` — after the "Those last four can still _call_ a tubeless pipeline…" paragraph (L45-47), add the two-compositions table from the spec (host embedding = durable graph; `fromRemote` = mixed placement). Keep the existing "wrong default" bullet that the pipeline must outlive the process.

`docs/concepts.md` — add a **Remote steps** section immediately after **Child pipelines** (L409-415):

```
## Remote steps

Use `step.fromRemote` when one parent step's work lives on another engine.
The parent plan stays local and opaque; `remote.engine` and optional
`remote.target` are presentation only. Dry-run remains a side-effect gate:
omitting `dryRun` still calls the adapter. See
[remote-step composition](../../../docs/remote-step-composition.md).
```

`docs/README.md` Deeper reference table — add a row for `docs/remote-step-composition.md` next to child-pipeline composition (L26).

`docs/llms.txt` — add `- Remote steps: ./remote-step-composition.md` under Advanced (after L47), and `- ../examples/remote-steps.ts` under Executable examples (after L60).

`scripts/verify-packed-artifact.mjs`:

1. Add a runner next to `"child-pipeline.ts"`:

```js
  "remote-steps.ts": async (mod) => {
    defined(await mod.runRemoteStepsExample(), "remote-steps.ts");
  },
```

2. Add these paths to the packed-file existence list (`scripts/verify-packed-artifact.mjs:264-281`) next to the child-pipeline / catalog import entries:

```
    "docs/remote-step-composition.md",
    "examples/catalog/pipelines/enrich.ts",
    "examples/catalog/scripts/enrich.ts",
```

Linking `remote-steps.ts` from recipes without a runner fails `pack:verify` with `no packed-example runner`.

- [ ] **Step 4: Verify the learning surface**

```bash
bun run typecheck
bun run docs:check
bun run test:run -- src/remote-step.test.ts src/render.test.ts src/public-api.example.test.ts
```

`src/public-api.example.test.ts` needs dist; if it fails on a stale entry, use `bun run test -- src/public-api.example.test.ts`.

Expected: PASS. `docs:check` fails if a new markdown link is broken or `llms.txt` points at a missing file.

Then run `make check` from the package root.

Expected: PASS, including `api:check` and `pack:verify` (the new recipes.md link plus runner).

- [ ] **Step 5: Commit**

```bash
git add examples/remote-steps.ts examples/catalog/pipelines/enrich.ts examples/catalog/scripts/enrich.ts examples/catalog/tubeless.studio.ts docs/remote-step-composition.md docs/recipes.md docs/agent-guide.md docs/comparison.md docs/concepts.md docs/README.md docs/llms.txt scripts/verify-packed-artifact.mjs
git commit -m "Document fromRemote and add the mixed-engine recipe."
```

---

## Self-review

**Spec coverage**

| Spec requirement | Task |
| --- | --- |
| `RemoteStepAdapter` + `invoke(payload, context)` | 1 |
| Inverse dry-run contract; factory does not stamp `"skip"` | 1 |
| Optional `context.log`; required throw-through; no `TUBELESS_REMOTE_*` | 1 |
| Plain `Error` (not child/execution error) → `TUBELESS_STEP_FAILED` | 1 |
| `fromRemote` / `fromRemote.skippable`; required `outputSchema`; no `mapResult` | 1 |
| `mapInput` takes `PipelineStepContext` | 1 |
| `STEP_REMOTE` + `PipelinePlanStep.remote` | 1 |
| Dry-run omit / skip / preview | 1 |
| Plan enum stays `"custom" \| "run" \| "skip"` | 1 |
| Human plan text + no `"rehearse"` | 2 |
| Trace `remote` next to `nested_pipeline` | 2 |
| Run-store parse/retain + studio kind | 2 |
| Mermaid unchanged | 2 (no code) |
| Public export + `api:generate` | 3 |
| Recipes, agent guide, comparison, concepts, composition doc, README, llms, example, catalog | 4 |
| Packed runner for recipes.md-linked example | 4 |
| Skill.md unchanged | 4 |
| No placement driver / official SDKs / `executePlannedRun` engine branch | Global constraints |

**Placeholder scan:** none. Tests and implementation snippets are concrete. File:line citations name current seams.

**Type consistency:** `RemoteStepAdapter<TOptions, TPayload, TResult>`, `PipelinePlanStep.remote: { engine: string; target?: string }`, `STEP_REMOTE`, `fromRemote` / `fromRemote.skippable`, stored field `remote`, trace attribute `remote`. Job ids stay out of `PipelineStepContext` and `PipelineStepReport`.
