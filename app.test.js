import { expect, test } from "vitest";
import { answer } from "./app.js";
test("returns the expected answer", () => {
  expect(answer).toBe(42);
});
