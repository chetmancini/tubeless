// Portable declarations compile without ambient Node types.
import {
  CHECK_REPORT_LIMITS,
  readCheckReport,
  decodeCheckReportResult,
  projectStructuredErrors,
  structuredError,
  STRUCTURED_ERROR_LIMITS,
  type CheckReport,
  type CheckReportResult,
  type CheckProcessOutcome,
} from "tubeless/check-report";
import { vitestCheckReport } from "tubeless/node";

const process: CheckProcessOutcome = {
  status: "exited",
  exitCode: 1,
  signal: null,
  outputComplete: true,
};
const context: CheckReport["context"] = { pipelineId: "check", runId: "run", stepId: "test" };
const decoded: CheckReportResult = readCheckReport(undefined);
const adapted: CheckReportResult = vitestCheckReport(undefined, {
  root: "/source",
  toolVersion: "5.1.0",
  context,
  process,
});
const limit: number = CHECK_REPORT_LIMITS.bytes;

const bounded = structuredError({ message: "failure", sourceCode: "EFAIL" });
const projected = projectStructuredErrors([bounded]);
const result = decodeCheckReportResult(adapted);
const errorLimit: number = STRUCTURED_ERROR_LIMITS.bytes;
