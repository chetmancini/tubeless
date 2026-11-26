import { appendFileSync } from "node:fs";
import { expect, inject } from "vitest";

export function mark(file) {
  appendFileSync(new URL("./executed.log", import.meta.url), file + "\n");
  expect(inject("gate")).toBe("global setup ran");
  expect(globalThis.fixtureSetup).toBe(true);
}
