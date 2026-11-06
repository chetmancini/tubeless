export const DEFAULT_RUN_EVENT_PAGE_SIZE = 20_000;

export function runEventPageLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(100_000, Math.floor(limit ?? DEFAULT_RUN_EVENT_PAGE_SIZE)));
}
