import { expect, test } from "vitest";
import { answer } from "../app.js";
import { mark } from "../mark.js";

test("returns the fixture's answer", () => {
  mark("spec/check.case.js");
  expect(answer).toBe(42);
});
