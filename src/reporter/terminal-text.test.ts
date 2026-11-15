import { describe, expect, it } from "vitest";
import { createTerminalLogSanitizer, safeTerminalLog, safeTerminalText } from "./terminal-text.js";

describe("terminal text sanitizers", () => {
  it("strips bidirectional controls from text", () => {
    expect(safeTerminalText("a\u202Eb\u2066c\u200Fd\u061Ce")).toBe("abcde");
  });

  it("strips bidirectional controls from logs", () => {
    expect(safeTerminalLog("x\u202Ay\n")).toBe("xy\n");
  });

  it("still removes escape sequences and normalizes whitespace", () => {
    expect(safeTerminalText("a\u001B[31mred\u001B[0m  b\n")).toBe("ared b");
    expect(safeTerminalLog("one\r\ntwo\tthree")).toBe("one\ntwo three");
  });

  it("keeps ordinary non-Latin text", () => {
    expect(safeTerminalText("مرحبا 你好")).toBe("مرحبا 你好");
  });
  it.each([
    { input: "a\u001B[31mred\u001B[0mb", expected: "aredb" },
    { input: "a\u009B31mred\u009B0mb", expected: "aredb" },
    {
      input: "a\u001B]8;;https://private.example\u0007label\u001B]8;;\u001B\\b",
      expected: "alabelb",
    },
    { input: "a\u009Dprivate title\u009Cb", expected: "ab" },
    { input: "a\u001BPprivate data\u001B\\b", expected: "ab" },
    { input: "a\u0098private data\u009Cb", expected: "ab" },
    { input: "a\r\nb\tc\u202Ad", expected: "a\nb cd" },
  ])("sanitizes whole and arbitrarily split terminal text: $expected", ({ input, expected }) => {
    expect(safeTerminalLog(input)).toBe(expected);
    for (let split = 1; split < input.length; split++) {
      const sanitize = createTerminalLogSanitizer();
      expect(sanitize(input.slice(0, split)) + sanitize(input.slice(split))).toBe(expected);
    }
    const sanitize = createTerminalLogSanitizer();
    expect([...input].map(sanitize).join("")).toBe(expected);
  });

  it("discards unterminated terminal strings without retaining or revealing their content", () => {
    const sanitize = createTerminalLogSanitizer();
    expect(sanitize("before\u001B]private")).toBe("before");
    expect(sanitize("x".repeat(100_000))).toBe("");
    expect(sanitize("\u001B")).toBe("");
    expect(sanitize("\\after")).toBe("after");
  });
});
