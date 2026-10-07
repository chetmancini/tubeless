const TERMINAL_TOKEN = /\u001B\[([?0-9;]*)([A-Za-z])|[\s\S]/gu;

/**
 * Replays ticker output into the rows an xterm-style terminal would show, with
 * unbounded scrollback, one column per code point, and no resize reflow.
 * Like xterm, writing the last column leaves a pending wrap, so a following
 * erase-to-end-of-line removes that final character.
 */
export function renderTerminal(output: string, columns = Number.POSITIVE_INFINITY): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let column = 0;
  let pendingWrap = false;
  const nextRow = (): void => {
    row += 1;
    column = 0;
    pendingWrap = false;
    rows[row] ??= [];
  };
  for (const [token, params, command] of output.matchAll(TERMINAL_TOKEN)) {
    const cells = rows[row]!;
    if (command === "F") {
      row = Math.max(0, row - (Number(params) || 1));
      column = 0;
      pendingWrap = false;
    } else if (command === "J") {
      cells.length = Math.min(cells.length, column);
      rows.length = row + 1;
    } else if (command === "K") {
      cells.length = Math.min(cells.length, column);
    } else if (command !== undefined) {
      // Styles, cursor visibility, and synchronized output do not move content.
    } else if (token === "\n") {
      // Terminal output post-processing (ONLCR) turns LF into CR LF.
      nextRow();
    } else if (token === "\r") {
      column = 0;
      pendingWrap = false;
    } else {
      if (pendingWrap) nextRow();
      const target = rows[row]!;
      while (target.length < column) target.push(" ");
      target[column] = token;
      if (column + 1 >= columns) pendingWrap = true;
      else column += 1;
    }
  }
  if (rows.length > 1 && rows.at(-1)!.length === 0) rows.pop();
  return rows.map((cells) => cells.join("").trimEnd());
}
