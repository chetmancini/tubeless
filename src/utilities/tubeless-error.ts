const TUBELESS_ERROR = Symbol.for("tubeless.error");

export function brandTubelessError(error: Error, kind: string): void {
  Object.defineProperty(error, TUBELESS_ERROR, {
    configurable: false,
    enumerable: false,
    value: kind,
    writable: false,
  });
}

export function tubelessErrorKind(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const kind = Object.getOwnPropertyDescriptor(error, TUBELESS_ERROR)?.value;
  return typeof kind === "string" ? kind : undefined;
}
