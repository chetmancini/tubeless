import { formatDurationMs } from "./reporter.js";

export const SPINNER_TOKEN = "\u0001";
const ELAPSED_TOKEN_START = "\u0002";
const ELAPSED_TOKEN_END = "\u0003";
const SHIMMER_TOKEN_START = "\u0004";
const SHIMMER_TOKEN_END = "\u0005";

export const TICKER_ANSI = {
  clearDown: "\u001B[J",
  hideCursor: "\u001B[?25l",
  reset: "\u001B[0m",
  showCursor: "\u001B[?25h",
} as const;

const SHIMMER_BAND_COLUMNS = 3;
const SHIMMER_BRIGHT = "\u001B[0;1;36m";
const SHIMMER_DIM = "\u001B[0;2;36m";
const SHIMMER_FRAME_MS = 80;

const ANSI_STYLE = /\u001B\[[0-9;]*m/g;
const ANSI_STYLE_PREFIX = /^\u001B\[[0-9;]*m/;
const COMBINING_MARK = /\p{Mark}/u;
const EMOJI = /\p{Extended_Pictographic}/u;

const SPINNERS = {
  ascii: ["-", "\\", "|", "/"],
  unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const;

function characterWidth(character: string): number {
  if (COMBINING_MARK.test(character) || character === "\u200D") return 0;
  if (EMOJI.test(character)) return 2;
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
    ? 2
    : 1;
}

function visibleWidth(value: string): number {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}

function fitLine(value: string, columns: number | undefined, unicode: boolean): string {
  if (!columns || columns <= 1) return value;
  const maxWidth = columns - 1;
  const plain = value.replace(ANSI_STYLE, "");
  if (visibleWidth(plain) <= maxWidth) return value;
  const ellipsis = unicode ? "…" : ".".repeat(Math.min(3, maxWidth));
  const targetWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));
  let width = 0;
  let truncated = "";
  let index = 0;
  let hasStyle = false;
  while (index < value.length) {
    const style = value.slice(index).match(ANSI_STYLE_PREFIX)?.[0];
    if (style) {
      truncated += style;
      index += style.length;
      hasStyle = true;
      continue;
    }
    const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
    const nextWidth = width + characterWidth(character);
    if (nextWidth > targetWidth) break;
    truncated += character;
    width = nextWidth;
    index += character.length;
  }
  return `${truncated}${hasStyle ? TICKER_ANSI.reset : ""}${ellipsis}`;
}

export function elapsedToken(startedAtMs: number): string {
  return `${ELAPSED_TOKEN_START}${startedAtMs}${ELAPSED_TOKEN_END}`;
}

export function shimmerToken(value: string): string {
  return `${SHIMMER_TOKEN_START}${value}${SHIMMER_TOKEN_END}`;
}

function paintShimmerText(text: string, nowMs: number): string {
  const characters = [...text];
  if (characters.length === 0) return text;
  const widths = characters.map(characterWidth);
  const totalWidth = visibleWidth(text);
  const period = Math.max(1, totalWidth + SHIMMER_BAND_COLUMNS);
  const head = Math.floor(nowMs / SHIMMER_FRAME_MS) % period;
  const bandStart = head - SHIMMER_BAND_COLUMNS + 1;
  let column = 0;
  let output = TICKER_ANSI.reset;
  let last: "bright" | "dim" | undefined;
  for (const [index, character] of characters.entries()) {
    const width = widths[index] ?? 0;
    const inBand =
      width === 0 ? last === "bright" : column <= head && column + width - 1 >= bandStart;
    const style = inBand ? "bright" : "dim";
    if (style !== last) {
      output += style === "bright" ? SHIMMER_BRIGHT : SHIMMER_DIM;
      last = style;
    }
    output += character;
    column += width;
  }
  return `${output}${TICKER_ANSI.reset}`;
}

function replaceLiveTokens(line: string, spinner: string, nowMs: number, color: boolean): string {
  return line
    .replaceAll(SPINNER_TOKEN, spinner)
    .replace(
      new RegExp(`${ELAPSED_TOKEN_START}(\\d+)${ELAPSED_TOKEN_END}`, "g"),
      (_match, start: string) => formatDurationMs(Math.max(0, nowMs - Number(start)))
    )
    .replace(
      new RegExp(`${SHIMMER_TOKEN_START}(.*?)${SHIMMER_TOKEN_END}`, "g"),
      (_match, text: string) => (color ? paintShimmerText(text, nowMs) : text)
    );
}

export function paintLiveLines(
  lines: readonly string[],
  spinner: string,
  nowMs: number,
  columns?: number,
  color = false,
  unicode = true,
  logPane?: readonly string[]
): string[] {
  const painted = lines.map((line) => replaceLiveTokens(line, spinner, nowMs, color));
  if (!logPane || !columns || columns < 120) {
    return painted.map((line) => fitLine(line, columns, unicode));
  }
  const paneWidth = Math.min(60, Math.floor(columns * 0.4));
  const leftWidth = columns - paneWidth - 3;
  const horizontal = unicode ? "─" : "-";
  const vertical = unicode ? "│" : "|";
  const pad = (line: string, width: number): string => {
    const fitted = fitLine(line, width + 1, unicode);
    return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted.replace(ANSI_STYLE, ""))));
  };
  const pane = [
    `${unicode ? "╭" : "+"}${horizontal} Logs ${horizontal.repeat(paneWidth - 9)}${unicode ? "╮" : "+"}`,
    ...logPane.map((line) => `${vertical} ${pad(line, paneWidth - 4)} ${vertical}`),
    `${unicode ? "╰" : "+"}${horizontal.repeat(paneWidth - 2)}${unicode ? "╯" : "+"}`,
  ];
  return Array.from({ length: Math.max(painted.length, pane.length) }, (_, index) =>
    pane[index] === undefined
      ? fitLine(painted[index] ?? "", leftWidth + 1, unicode)
      : `${pad(painted[index] ?? "", leftWidth)}  ${pane[index]}`
  );
}

export class TickerFrame {
  private cursorHidden: boolean;

  constructor(
    private readonly write: (chunk: string) => void,
    private paintedLines: readonly string[] = []
  ) {
    this.cursorHidden = paintedLines.length > 0;
  }

  showCursor(): void {
    if (!this.cursorHidden) return;
    this.write(TICKER_ANSI.showCursor);
    this.cursorHidden = false;
  }

  clear(columns?: number): void {
    if (this.paintedLines.length === 0) return;
    // Resizing can reflow each previously painted line across several rows.
    // Count those rows at the current width before moving back to the frame start.
    let rows = this.paintedLines.length;
    if (columns !== undefined && columns > 0) {
      rows = 0;
      for (const line of this.paintedLines) {
        rows += 1;
        let column = 0;
        for (const character of line.replace(ANSI_STYLE, "")) {
          const width = characterWidth(character);
          if (column + width > columns) {
            rows += 1;
            column = 0;
          }
          column += width;
        }
      }
    }
    this.write(`\u001B[${rows}F${TICKER_ANSI.clearDown}`);
    this.paintedLines = [];
  }

  redraw(lines: readonly string[], columns?: number): void {
    if (!this.cursorHidden) {
      this.write(TICKER_ANSI.hideCursor);
      this.cursorHidden = true;
    }
    this.clear(columns);
    if (lines.length === 0) return;
    this.write(`${lines.join("\n")}\n`);
    this.paintedLines = lines;
  }
}

export function currentSpinner(unicode: boolean, refreshIntervalMs: number): string {
  const frames = unicode ? SPINNERS.unicode : SPINNERS.ascii;
  return frames[Math.floor(Date.now() / refreshIntervalMs) % frames.length] ?? frames[0]!;
}

export function hasLiveAnimation(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes(SPINNER_TOKEN) || line.includes(SHIMMER_TOKEN_START));
}
