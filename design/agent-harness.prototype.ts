/**
 * Stage 1 declarations only. Nothing in this file implements an agent or is
 * exported by the package. See agent-harness.md for the execution contract.
 */
import type {
  Pipeline,
  PipelineDefinitionSnapshot,
  PipelineInput,
  PipelineResult,
  PipelineStepContext,
  StandardSchemaV1,
} from "tubeless";

type Awaitable<T> = T | Promise<T>;
type Input<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];
type Output<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
type AnyPipeline = Pipeline<object, unknown>;
declare const capabilityTypes: unique symbol;

/** Opaque descriptor, created by defineTool or pipelineTool; never a raw model value. */
export interface AgentTool<Arguments, Result> {
  readonly [capabilityTypes]: { readonly input: Arguments; readonly output: Result };
}

type Tools = Readonly<Record<string, AgentTool<unknown, unknown>>>;

/** The model describes raw arguments. Dispatch supplies validated arguments to handlers. */
export type AgentCall<Registry extends Tools> = {
  [Name in keyof Registry & string]: {
    readonly id: string;
    readonly tool: Name;
    readonly input: Registry[Name][typeof capabilityTypes]["input"];
  };
}[keyof Registry & string];

export type AgentOutcome<Registry extends Tools> = {
  [Name in keyof Registry & string]: { readonly id: string; readonly tool: Name } & (
    | { readonly ok: true; readonly value: Registry[Name][typeof capabilityTypes]["output"] }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  );
}[keyof Registry & string];

export type AgentDecision<Registry extends Tools, Result> =
  | {
      readonly kind: "continue";
      readonly calls: readonly [AgentCall<Registry>, ...AgentCall<Registry>[]];
      readonly result?: never;
    }
  | { readonly kind: "finish"; readonly result: Result; readonly calls?: never };

/** Only this handler-thrown error is eligible to become a recoverable observation. */
export declare class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export declare function defineTool<
  const Arguments extends StandardSchemaV1,
  const Result extends StandardSchemaV1,
>(definition: {
  readonly description: string;
  readonly inputSchema: Arguments;
  readonly outputSchema: Result;
  /** Required at definition time if the input schema lacks JSON Schema conversion. */
  readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
  run(input: Output<Arguments>, context: PipelineStepContext<{}>): Awaitable<Input<Result>>;
  /** Omitted means skip during an agent preview. */
  readonly dryRun?:
    | "skip"
    | ((input: Output<Arguments>, context: PipelineStepContext<{}>) => Awaitable<Input<Result>>);
}): AgentTool<Input<Arguments>, Output<Result>>;

/** Reuse a child's schema when the model arguments already match its input. */
export declare function pipelineTool<const Child extends AnyPipeline>(
  pipeline: Child & { readonly optionsSchema: StandardSchemaV1 },
  metadata: {
    readonly description: string;
    readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
  }
): AgentTool<PipelineInput<Child>, PipelineResult<Child>>;

/** Explicit boundary for schema-less children or differently shaped model arguments. */
export declare function pipelineTool<
  const Child extends AnyPipeline,
  const Arguments extends StandardSchemaV1,
>(
  pipeline: Child,
  definition: {
    readonly description: string;
    readonly inputSchema: Arguments;
    readonly inputJsonSchema?: Readonly<Record<string, unknown>>;
    mapOptions(input: Output<Arguments>): PipelineInput<Child>;
  }
): AgentTool<Input<Arguments>, PipelineResult<Child>>;

export interface AgentLimits {
  /** Per invocation; default 20. Includes a final decision. */
  readonly maxTurns?: number;
  /** Shared across descendants; default 100. Includes delegation admissions. */
  readonly maxCalls?: number;
  /** Shared decision invocations, not provider-internal HTTP retries; default 100. */
  readonly maxDecisions?: number;
  /** Delegation levels below this invocation; default 4. Zero permits leaf tools only. */
  readonly maxDepth?: number;
  /** Active decision callbacks and leaf tool handlers; default 1. */
  readonly maxConcurrency?: number;
}

export interface AgentDecisionContext<Options extends object> extends PipelineStepContext<Options> {
  readonly turn: number;
  readonly stateVersion: number;
  readonly capabilities: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  }[];
  /** JSON Schema for the raw finish result, before resultSchema transformation. */
  readonly resultJsonSchema: Readonly<Record<string, unknown>>;
}

export declare function defineAgent<
  const Id extends string,
  const Options extends StandardSchemaV1<object, object>,
  const Result extends StandardSchemaV1,
  State,
  const Registry extends Tools = {},
>(definition: {
  readonly id: Id;
  readonly name?: string;
  readonly description?: string;
  readonly implementationVersion?: string;
  readonly inputSchema: Options;
  readonly resultSchema: Result;
  readonly resultJsonSchema?: Readonly<Record<string, unknown>>;
  readonly tools?: Registry;
  readonly limits?: AgentLimits;
  initialState(options: Output<Options>): State;
  /** Untrusted model data always goes through runtime decision validation. */
  decide(
    state: DeepReadonly<NoInfer<State>>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<unknown>;
  /** Omitted reducer preserves state; specify one when decisions consume observations. */
  reduce?(
    state: DeepReadonly<NoInfer<State>>,
    outcomes: readonly AgentOutcome<NoInfer<Registry>>[]
  ): NoInfer<State>;
  /** Optional replacement for decide in a dry run; tools retain their own dry-run policy. */
  dryRun?(
    state: DeepReadonly<NoInfer<State>>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<unknown>;
}): Pipeline<Input<Options>, Output<Result>, "agent", "agent", Id> & {
  readonly optionsSchema: Options;
  readonly definition: PipelineDefinitionSnapshot;
};
