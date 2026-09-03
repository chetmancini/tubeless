/** Stable shell exit codes for the workbench command family. */
export const TUBELESS_WORKBENCH_EXIT_CODE = {
  success: 0,
  usage: 1,
  load: 2,
  definition: 3,
  validation: 4,
  planning: 5,
  execution: 6,
  cancellation: 7,
} as const;
