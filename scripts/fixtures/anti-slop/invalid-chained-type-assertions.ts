declare const value: string;

// SAFETY: this fixture isolates the chained-assertion rule.
export const result = value as unknown as { readonly id: string };
