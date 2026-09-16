declare const value: { readonly id: string };

// SAFETY: the assertion preserves the declared value shape.
export const result = value as { readonly id: string };
