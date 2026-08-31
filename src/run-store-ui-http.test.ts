import { describe, expect, it } from "vitest";
import {
  formatHttpUrlHost,
  isLiteralOrLocalhostHttpHost,
  isUnspecifiedHttpHost,
  normalizeHttpAuthority,
  parseHttpAuthority,
} from "./run-store-ui-http.js";

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

  it("identifies unspecified bind hosts", () => {
    expect(isUnspecifiedHttpHost("0.0.0.0")).toBe(true);
    expect(isUnspecifiedHttpHost("::")).toBe(true);
    expect(isUnspecifiedHttpHost("127.0.0.1")).toBe(false);
    expect(isUnspecifiedHttpHost("::1")).toBe(false);
  });

  it("accepts localhost and literal IPs as wildcard Host names", () => {
    expect(isLiteralOrLocalhostHttpHost("localhost")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("LOCALHOST")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("127.0.0.1")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("192.0.2.10")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("::1")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("[::1]")).toBe(true);
    expect(isLiteralOrLocalhostHttpHost("evil.example")).toBe(false);
    expect(isLiteralOrLocalhostHttpHost("0.0.0.0")).toBe(true);
  });

  it("splits a normalized authority into hostname and port", () => {
    expect(parseHttpAuthority("127.0.0.1:4317")).toEqual({ hostname: "127.0.0.1", port: "4317" });
    expect(parseHttpAuthority("[::1]:4317")).toEqual({ hostname: "::1", port: "4317" });
    expect(parseHttpAuthority("127.0.0.1:80")).toEqual({ hostname: "127.0.0.1", port: "" });
    expect(parseHttpAuthority(undefined)).toBeUndefined();
  });
});
