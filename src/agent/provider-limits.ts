export const MAX_REQUEST_BYTES = 1_048_576;
export const MAX_TOOL_OUTPUT_BYTES = 262_144;
export const DEFAULT_COMPACT_AFTER_BYTES = MAX_REQUEST_BYTES - MAX_TOOL_OUTPUT_BYTES;
export const MAX_RESPONSE_BYTES = 2_097_152;
export const DEFAULT_MAX_RETRIES = 2;

export function validProviderLimits(
  timeoutMs: number,
  maxRetries: number,
  compactAfterBytes: number | null
): boolean {
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1 &&
    timeoutMs <= 2_147_483_647 &&
    Number.isSafeInteger(maxRetries) &&
    maxRetries >= 0 &&
    maxRetries <= 10 &&
    (compactAfterBytes === null ||
      (Number.isSafeInteger(compactAfterBytes) &&
        compactAfterBytes >= 1 &&
        compactAfterBytes < MAX_REQUEST_BYTES))
  );
}
