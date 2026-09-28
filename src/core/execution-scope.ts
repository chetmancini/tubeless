/** Private runtime transport. Core carries the scope and brackets leaf handlers only. */
export interface ExecutionScope {
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

const EXECUTION_SCOPE: unique symbol = Symbol("tubeless.executionScope");
type Scoped = { [EXECUTION_SCOPE]?: ExecutionScope };

export function executionScope(context: object): ExecutionScope | undefined {
  return (context as Scoped)[EXECUTION_SCOPE];
}

export function setExecutionScope(context: object, scope: ExecutionScope): void {
  Object.assign(context, { [EXECUTION_SCOPE]: scope });
}

export function inheritExecutionScope<T extends object>(source: object, target: T): T {
  const scope = executionScope(source);
  if (scope) setExecutionScope(target, scope);
  return target;
}
