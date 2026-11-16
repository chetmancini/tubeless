import { describe, expect, it } from "vitest";

describe("structured failure", () => {
  it("reports the expected value", () => {
    expect(2 + 2).toBe(5);
  });
  it("passes", () => expect(2 + 2).toBe(4));
  it.skip("skips", () => {});
  it.todo("later");
  it.each([1, 2])("parameter %i", (value) => expect(value).toBeGreaterThan(0));
  it("duplicate", () => {});
  it("duplicate", () => {});
  let attempts = 0;
  it("retried", { retry: 1 }, () => expect(++attempts).toBe(2));
});
