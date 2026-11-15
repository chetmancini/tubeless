// C0/C1 controls plus bidirectional formatting controls that can reorder displayed text.
const TERMINAL_CONTROL =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
type ControlState = "text" | "escape" | "csi" | "osc" | "string" | "osc-escape" | "string-escape";

/** Discard terminal sequences without retaining their potentially large payloads. */
function createTerminalControlStripper(): (value: string) => string {
  let state: ControlState = "text";
  return (value) => {
    let output = "";
    for (const char of value) {
      if (state === "osc" || state === "string") {
        if (char === "\u009C" || (state === "osc" && char === "\u0007")) state = "text";
        else if (char === "\u001B") state = state === "osc" ? "osc-escape" : "string-escape";
        continue;
      }
      if (state === "osc-escape" || state === "string-escape") {
        if (char === "\\" || char === "\u009C" || (state === "osc-escape" && char === "\u0007"))
          state = "text";
        else if (char !== "\u001B") state = state === "osc-escape" ? "osc" : "string";
        continue;
      }
      if (state === "csi") {
        if (char >= "@" && char <= "~") {
          state = "text";
          continue;
        }
        if (char >= " " && char <= "?") continue;
        state = "text";
      }
      if (state === "escape") {
        state = "text";
        if (char === "[") {
          state = "csi";
          continue;
        }
        if (char === "]") {
          state = "osc";
          continue;
        }
        if ("P_X^".includes(char)) {
          state = "string";
          continue;
        }
        if (char >= "@" && char <= "_") continue;
      }
      if (char === "\u001B") state = "escape";
      else if (char === "\u009B") state = "csi";
      else if (char === "\u009D") state = "osc";
      else if ("\u0090\u0098\u009E\u009F".includes(char)) state = "string";
      else output += char;
    }
    return output.replace(TERMINAL_CONTROL, "");
  };
}

export function safeTerminalText(value: string): string {
  return createTerminalControlStripper()(value.replace(/\s+/g, " ")).trim();
}

/** One sanitizer per text stream; preserve escape and CRLF state across deltas. */
export function createTerminalLogSanitizer(): (value: string) => string {
  const strip = createTerminalControlStripper();
  let afterCR = false;
  return (value) => {
    if (!value) return "";
    const next = afterCR && value.startsWith("\n") ? value.slice(1) : value;
    afterCR = value.endsWith("\r");
    return strip(next.replace(/\r\n?/g, "\n").replaceAll("\t", " "));
  };
}

export function safeTerminalLog(value: string): string {
  return createTerminalLogSanitizer()(value);
}
