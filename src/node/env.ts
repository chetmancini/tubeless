export function requireEnv(varName: string, usedBy: string): string {
  const value = process.env[varName];
  if (!value) {
    throw new Error(`${varName} is required for ${usedBy}`);
  }
  return value;
}
