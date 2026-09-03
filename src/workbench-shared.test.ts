import { describe, expect, it } from "vitest";
import {
  isCliHelpRequested,
  isCliValidationError,
  isPipelineExecutionError,
  toExitCode,
  TUBELESS_WORKBENCH_EXIT_CODE,
} from "./workbench-shared.js";

describe("workbench error predicates", () => {
  it("recognizes unbranded CliHelpRequested copies by name and helpText", () => {
    const error = Object.assign(new Error("Usage: toy\n"), {
      helpText: "Usage: toy\n",
      name: "CliHelpRequested",
    });
    expect(isCliHelpRequested(error)).toBe(true);
    expect(toExitCode(error)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
  });

  it("recognizes unbranded CliValidationError copies by name and payload", () => {
    const error = Object.assign(new Error("Invalid command-line arguments"), {
      errors: ["Pass --message."],
      helpText: "Usage: toy\n",
      name: "CliValidationError",
    });
    expect(isCliValidationError(error)).toBe(true);
    expect(toExitCode(error)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.validation);
  });

  it("recognizes unbranded PipelineExecutionError copies by name and result", () => {
    const error = Object.assign(new Error("Pipeline failed"), {
      name: "PipelineExecutionError",
      result: {
        errors: [{ code: "TUBELESS_STEP_FAILED", kind: "failure", message: "boom", phase: "run" }],
      },
    });
    expect(isPipelineExecutionError(error)).toBe(true);
    expect(toExitCode(error)).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
  });
});
