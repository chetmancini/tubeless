const entities = new Map([
  ["amp", "&"],
  ["AMP", "&"],
  ["quot", '"'],
  ["QUOT", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["LT", "<"],
  ["gt", ">"],
  ["GT", ">"],
  ["nbsp", "\u00a0"],
]);

export function decodeHtml(value) {
  return value.replace(/&(#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (!entity.startsWith("#")) return entities.get(entity) ?? match;
    const hex = entity[1] === "x" || entity[1] === "X";
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "\ufffd"
      : String.fromCodePoint(codePoint);
  });
}
