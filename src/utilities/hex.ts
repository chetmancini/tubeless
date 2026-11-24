const digits = "0123456789abcdef";

/** Encode bytes as lowercase hex on every supported Node and Worker runtime. */
export function encodeHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += digits[byte >> 4] + digits[byte & 15];
  return hex;
}
