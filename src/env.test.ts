import { afterEach, describe, expect, it } from "vitest";
import { requireEnv } from "./env";

describe("requireEnv", () => {
  const originalValue = process.env.REQUIRE_ENV_TEST_VAR;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.REQUIRE_ENV_TEST_VAR;
    } else {
      process.env.REQUIRE_ENV_TEST_VAR = originalValue;
    }
  });

  it("returns the env var's value when set", () => {
    process.env.REQUIRE_ENV_TEST_VAR = "secret-value";
    expect(requireEnv("REQUIRE_ENV_TEST_VAR", "SomeCaller")).toBe("secret-value");
  });

  it("throws a descriptive error when the env var is missing", () => {
    delete process.env.REQUIRE_ENV_TEST_VAR;
    expect(() => requireEnv("REQUIRE_ENV_TEST_VAR", "SomeCaller")).toThrow(
      "REQUIRE_ENV_TEST_VAR is required for SomeCaller"
    );
  });

  it("throws when the env var is set but empty", () => {
    process.env.REQUIRE_ENV_TEST_VAR = "";
    expect(() => requireEnv("REQUIRE_ENV_TEST_VAR", "SomeCaller")).toThrow(
      "REQUIRE_ENV_TEST_VAR is required for SomeCaller"
    );
  });
});
