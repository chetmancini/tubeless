export const STUDIO_PROGRESS_MAX_PERCENT = 100;

export function progressWidthClass(percent: number): string {
  return `w${Math.round(Math.max(0, Math.min(STUDIO_PROGRESS_MAX_PERCENT, percent)))}`;
}
