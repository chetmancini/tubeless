const encoder = new TextEncoder();

/** Web-standard UTF-8 encoding, including replacement of unpaired surrogates. */
export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function utf8ByteLength(value: string): number {
  return utf8Bytes(value).byteLength;
}
