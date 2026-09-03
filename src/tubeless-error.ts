export const TUBELESS_ERROR = Symbol.for("tubeless.error");

export function brandTubelessError(error: Error, kind: string): void {
  Object.defineProperty(error, TUBELESS_ERROR, {
    configurable: false,
    enumerable: false,
    value: kind,
    writable: false,
  });
}
