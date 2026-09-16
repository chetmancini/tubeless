export const EXECUTE_COMPILED_RUN: unique symbol = Symbol("tubeless.executeCompiledRun");

const compiledPipelines = new WeakSet<object>();

/** Marks the exact object returned by `definePipeline` as a compiled pipeline. */
export function brandCompiledPipeline(pipeline: object): void {
  compiledPipelines.add(pipeline);
}

/** True only for the object `definePipeline` returned, not `Object.create` wrappers. */
export function isCompiledPipeline(pipeline: object): boolean {
  return compiledPipelines.has(pipeline);
}
