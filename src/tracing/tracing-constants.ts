export const PIPELINE_TRACE_VERSION = 3 as const;
export const PIPELINE_TRACE_LIST_LIMIT = 128;
export const PIPELINE_TRACE_STRING_LIMIT = 4_096;
export const PIPELINE_TRACE_DETAIL_BYTE_LIMIT = 256 * 1_024;

export const STEP_CACHE_POLICIES = Object.freeze(["use", "recompute", "bypass"] as const);

export const PIPELINE_STEP_OUTPUT_SOURCES = Object.freeze([
  "override",
  "cache",
  "supplied",
] as const);
export type PipelineStepOutputSource = (typeof PIPELINE_STEP_OUTPUT_SOURCES)[number];

export function isStepCachePolicy(value: unknown): value is (typeof STEP_CACHE_POLICIES)[number] {
  return STEP_CACHE_POLICIES.some((policy) => policy === value);
}
