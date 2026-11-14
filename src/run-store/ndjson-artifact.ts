import { open } from "node:fs/promises";

/** Read one bounded, finished artifact; decode every line before returning its immutable view. */
export async function readNdjsonArtifact<T>(
  resolvedFilename: string,
  {
    maxBytes,
    maxLineBytes,
    maxRecords,
    kind,
  }: { maxBytes: number; maxLineBytes: number; maxRecords: number; kind: "trace" | "transcript" },
  decode: (value: unknown, index: number) => T
): Promise<T[]> {
  const handle = await open(resolvedFilename, "r");
  let contents: Buffer;
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`${resolvedFilename} is not a regular file.`);
    if (fileStat.size > maxBytes) {
      throw new Error(`${resolvedFilename} exceeds the ${maxBytes}-byte NDJSON ${kind} limit.`);
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > maxBytes) {
        throw new Error(`${resolvedFilename} exceeds the ${maxBytes}-byte NDJSON ${kind} limit.`);
      }
      chunks.push(buffer);
    }
    contents = Buffer.concat(chunks, byteLength);
  } finally {
    await handle.close();
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: T[] = [];
  let lineNumber = 0;
  let lineStart = 0;
  for (let cursor = 0; cursor <= contents.length; cursor += 1) {
    if (cursor < contents.length && contents[cursor] !== 0x0a) continue;
    lineNumber += 1;
    let lineEnd = cursor;
    if (lineEnd > lineStart && contents[lineEnd - 1] === 0x0d) lineEnd -= 1;
    const byteLength = lineEnd - lineStart;
    if (byteLength > maxLineBytes) {
      throw new Error(
        `${resolvedFilename} line ${lineNumber} exceeds the ${maxLineBytes}-byte ${kind === "trace" ? "event" : "record"} limit.`
      );
    }
    const line = contents.subarray(lineStart, lineEnd);
    lineStart = cursor + 1;
    if (line.every((byte) => byte === 0x20 || byte === 0x09)) continue;
    if (records.length >= maxRecords) {
      throw new Error(
        `${resolvedFilename} exceeds the ${maxRecords}-${kind === "trace" ? "event" : "record"} NDJSON ${kind} limit.`
      );
    }
    let decoded: string;
    try {
      decoded = decoder.decode(line);
    } catch {
      throw new Error(`${resolvedFilename} line ${lineNumber} is not valid UTF-8.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new Error(`${resolvedFilename} line ${lineNumber} is not valid JSON.`);
    }
    try {
      records.push(decode(parsed, records.length));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "event is invalid";
      throw new Error(`${resolvedFilename} line ${lineNumber} is invalid: ${detail}.`);
    }
  }

  return records;
}
