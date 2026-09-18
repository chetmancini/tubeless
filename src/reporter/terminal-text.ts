const TERMINAL_OSC = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const TERMINAL_STRING = /(?:\u001B[P_X^]|\u0090|\u0098|\u009E|\u009F)[\s\S]*?(?:\u001B\\|\u009C)/g;
const TERMINAL_CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const TERMINAL_ESCAPE = /\u001B[@-_]/g;
const TERMINAL_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

function stripTerminalControls(value: string): string {
  return value
    .replace(TERMINAL_OSC, "")
    .replace(TERMINAL_STRING, "")
    .replace(TERMINAL_CSI, "")
    .replace(TERMINAL_ESCAPE, "")
    .replace(TERMINAL_CONTROL, "");
}

export function safeTerminalText(value: string): string {
  return stripTerminalControls(value.replace(/\s+/g, " ")).trim();
}

export function safeTerminalLog(value: string): string {
  return stripTerminalControls(value.replace(/\r\n?/g, "\n").replaceAll("\t", " "));
}
