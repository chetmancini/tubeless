const agents = new WeakSet<object>();
export function markAgent(pipeline: object): void {
  agents.add(pipeline);
}
export function isAgent(pipeline: object): boolean {
  return agents.has(pipeline);
}
