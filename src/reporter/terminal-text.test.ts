import { describe, expect, it } from "vitest";
import { safeTerminalLog, safeTerminalText } from "./terminal-text.js";

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
});
