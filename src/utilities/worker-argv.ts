// --input-type applies to eval/stdin and is rejected when a worker loads a file.
export function fileWorkerExecArgv(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--input-type") {
      index += 1;
    } else if (!arg.startsWith("--input-type=")) {
      result.push(arg);
    }
  }
  return result;
}
