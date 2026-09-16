declare const value: unknown;

// SAFETY: this fixture documents the invariant immediately before the assertion.
export const result = value as { readonly id: string };
export const constant = "value" as const;
