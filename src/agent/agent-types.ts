import type { PipelineStepContext, StandardSchemaV1 } from "../core/pipeline-types.js";

export type Awaitable<T> = T | Promise<T>;
export type Input<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];
export type Output<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
/** Deeply read-only view of the owned plain-data state supplied to agent callbacks. */
export type AgentState<T> = { readonly [K in keyof T]: AgentState<T[K]> };
declare const capabilityTypes: unique symbol;

/** Opaque capability created by defineTool; model decisions contain data only. */
export interface AgentTool<Arguments, Result> {
  readonly [capabilityTypes]: { readonly input: Arguments; readonly output: Result };
}

export type Tools = Readonly<Record<string, AgentTool<unknown, unknown>>>;

/** One registered call with raw, pre-validation model arguments. */
export type AgentCall<Registry extends Tools> = {
  [Name in keyof Registry & string]: {
    readonly id: string;
    readonly tool: Name;
    readonly input: Registry[Name][typeof capabilityTypes]["input"];
  };
}[keyof Registry & string];

/** Input-order result or deliberately recoverable handler failure. */
export type AgentOutcome<Registry extends Tools> = {
  [Name in keyof Registry & string]: { readonly id: string; readonly tool: Name } & (
    | { readonly ok: true; readonly value: Registry[Name][typeof capabilityTypes]["output"] }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  );
}[keyof Registry & string];

/** A nonempty batch of independent calls, or the raw input to the final-result schema. */
export type AgentDecision<Registry extends Tools, Result> =
  | {
      readonly kind: "continue";
      readonly calls: readonly [AgentCall<Registry>, ...AgentCall<Registry>[]];
      readonly result?: never;
    }
  | { readonly kind: "finish"; readonly result: Result; readonly calls?: never };

/** Finite admission and active-execution limits for one agent invocation. */
export interface AgentLimits {
  /** Decision callbacks, including finish. Defaults to 20. */
  readonly maxTurns?: number;
  /** Admitted calls, including calls stopped before dispatch. Defaults to 100. */
  readonly maxCalls?: number;
  /** Decision callback admissions. Defaults to 100; provider retries are application-owned. */
  readonly maxDecisions?: number;
  /** Active tool handlers. Defaults to 1; decisions and call batches never overlap. */
  readonly maxConcurrency?: number;
}

/** Model-facing descriptors and ordinary step services, without executable tools. */
export interface AgentDecisionContext<Options extends object> extends PipelineStepContext<Options> {
  readonly turn: number;
  readonly stateVersion: number;
  readonly capabilities: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  }[];
  readonly resultJsonSchema: Readonly<Record<string, unknown>>;
}

export interface AgentDefinition<
  Id extends string,
  Options extends StandardSchemaV1<object, object>,
  Result extends StandardSchemaV1,
  State,
  Registry extends Tools,
> {
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
  decide(
    state: AgentState<NoInfer<State>>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<unknown>;
  reduce?(
    state: AgentState<NoInfer<State>>,
    outcomes: readonly AgentOutcome<NoInfer<Registry>>[]
  ): NoInfer<State>;
  dryRun?(
    state: AgentState<NoInfer<State>>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<unknown>;
}
