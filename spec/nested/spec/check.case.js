import { expect, test } from "vitest";
import { mark } from "../../../mark.js";

test("reports the controlled regression", () => {
  mark("spec/nested/spec/check.case.js");
  expect({ total: 41 }).toEqual({ total: 42 });
});
