import type { PipelineStepContext, StandardSchemaV1 } from "../core/pipeline-types.js";
import type { AgentEnvironment, AgentEnvironmentProvider } from "./environment.js";
import type { AgentDurability, AgentExecutionIdentity } from "./checkpoint-types.js";
import type { DefaultAgentTools } from "./default-tools.js";

export type Awaitable<T> = T | Promise<T>;
export type Input<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];
export type Output<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"];
/** Deeply read-only view of the owned plain-data state supplied to agent callbacks. */
export type AgentState<T> = { readonly [K in keyof T]: AgentState<T[K]> };
declare const capabilityTypes: unique symbol;

/** Opaque capability created by defineTool or pipelineTool; model decisions contain data only. */
export interface AgentTool<Arguments, Result> {
  readonly [capabilityTypes]: { readonly input: Arguments; readonly output: Result };
}

export type Tools = Readonly<Record<string, AgentTool<unknown, unknown>>>;
type RegisteredTools<Custom extends Tools> = Omit<DefaultAgentTools, keyof Custom> & Custom;

type ToolCall<Registry extends Tools> = {
  [Name in keyof Registry & string]: {
    readonly id: string;
    readonly tool: Name;
    readonly input: Registry[Name][typeof capabilityTypes]["input"];
  };
}[keyof Registry & string];

/** One built-in or custom call with raw model arguments; custom names replace defaults. */
export type AgentCall<Registry extends Tools = {}> = ToolCall<RegisteredTools<Registry>>;

type ToolOutcome<Registry extends Tools> = {
  [Name in keyof Registry & string]: {
    readonly id: string;
    readonly tool: Name;
  } & (
    | {
        readonly ok: true;
        readonly value: Registry[Name][typeof capabilityTypes]["output"];
      }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  );
}[keyof Registry & string];

/** Input-order result or deliberately recoverable handler failure, including default tools. */
export type AgentOutcome<Registry extends Tools = {}> = ToolOutcome<RegisteredTools<Registry>>;

/** A nonempty batch of independent calls, or the raw input to the final-result schema. */
export type AgentDecision<Registry extends Tools, Result> =
  | {
      readonly kind: "continue";
      readonly calls: readonly [AgentCall<Registry>, ...AgentCall<Registry>[]];
      readonly result?: never;
    }
  | { readonly kind: "finish"; readonly result: Result; readonly calls?: never };

/** Finite limits for this agent and its descendants; child limits may only tighten them. */
export interface AgentLimits {
  /** Decision callbacks, including finish. Defaults to 20. */
  readonly maxTurns?: number;
  /** Admitted subtree calls, including calls stopped before dispatch. Defaults to 100. */
  readonly maxCalls?: number;
  /** Subtree decision callback admissions. Defaults to 100; provider retries are application-owned. */
  readonly maxDecisions?: number;
  /** Pipeline-tool delegation edges below this agent. Defaults to 4; zero allows leaf tools only. */
  readonly maxDepth?: number;
  /** Active decision callbacks and leaf handlers across the subtree. Defaults to 1. */
  readonly maxConcurrency?: number;
}

/** Step services and the workspace capability available to a registered tool. */
export interface AgentToolContext extends PipelineStepContext<{}> {
  readonly environment: AgentEnvironment;
  readonly execution?: AgentExecutionIdentity;
}

/** Model-facing descriptors and ordinary step services, without executable tools. */
export interface AgentDecisionContext<Options extends object> extends PipelineStepContext<Options> {
  readonly environment: AgentEnvironment;
  readonly execution?: AgentExecutionIdentity;
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
  /** Semantic revision; required when this agent uses or inherits durable recovery. */
  readonly implementationVersion?: string;
  readonly inputSchema: Options;
  readonly resultSchema: Result;
  readonly resultJsonSchema?: Readonly<Record<string, unknown>>;
  /** Extend the standard tools; a custom tool with the same name replaces that default. */
  readonly tools?: Registry;
  readonly limits?: AgentLimits;
  /** Workspace capabilities; descendants inherit them unless explicitly replaced. */
  readonly environment?: AgentEnvironmentProvider;
  /** Acknowledged recovery checkpoints; requires an explicit implementationVersion. */
  readonly durability?: AgentDurability<Output<Options>>;
  initialState(options: Output<Options>): State;
  decide(
    state: AgentState<NoInfer<State>>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<unknown>;
  reduce?(
    state: AgentState<NoInfer<State>>,
    outcomes: readonly AgentOutcome<Registry>[]
  ): NoInfer<State>;
  dryRun?(
    state: AgentState<NoInfer<State>>,
    context: AgentDecisionContext<Output<Options>>
  ): Awaitable<unknown>;
}
