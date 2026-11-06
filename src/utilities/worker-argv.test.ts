import { expect, it } from "vitest";
import { fileWorkerExecArgv } from "./worker-argv.js";

it.each([
  { argv: [], expected: [] },
  { argv: ["--inspect", "--trace-warnings"], expected: ["--inspect", "--trace-warnings"] },
  { argv: ["--input-type=module", "--inspect"], expected: ["--inspect"] },
  {
    argv: ["--inspect", "--input-type", "commonjs", "--trace-warnings"],
    expected: ["--inspect", "--trace-warnings"],
  },
  { argv: ["--input-type", "module", "--input-type=commonjs"], expected: [] },
  { argv: ["--inspect", "--input-type"], expected: ["--inspect"] },
  {
    argv: ["--input-type-custom", "--require=./input-type.js"],
    expected: ["--input-type-custom", "--require=./input-type.js"],
  },
])("preserves file-compatible worker arguments from $argv", ({ argv, expected }) => {
  expect(fileWorkerExecArgv(Object.freeze(argv))).toEqual(expected);
});
