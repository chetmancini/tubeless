import { describe, expect, it } from "vitest";
import { formatHttpUrlHost, normalizeHttpAuthority } from "./run-store-ui-http.js";

describe("studio HTTP authorities", () => {
  it("brackets IPv6 literals for URLs", () => {
    expect(formatHttpUrlHost("127.0.0.1")).toBe("127.0.0.1");
    expect(formatHttpUrlHost("::1")).toBe("[::1]");
  });

  it("normalizes explicit default ports and preserves non-default ports", () => {
    expect(normalizeHttpAuthority("127.0.0.1:80")).toBe("127.0.0.1");
    expect(normalizeHttpAuthority("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHttpAuthority("[::1]:80")).toBe("[::1]");
    expect(normalizeHttpAuthority("[::1]")).toBe("[::1]");
    expect(normalizeHttpAuthority("LOCALHOST:4317")).toBe("localhost:4317");
  });

  it("rejects values that are not bare authorities", () => {
    expect(normalizeHttpAuthority(undefined)).toBeUndefined();
    expect(normalizeHttpAuthority("user@127.0.0.1")).toBeUndefined();
    expect(normalizeHttpAuthority("127.0.0.1/path")).toBeUndefined();
    expect(normalizeHttpAuthority("::1:4317")).toBeUndefined();
  });
});
