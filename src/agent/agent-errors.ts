export function agentError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

export function limit(
  name: string,
  bound: number,
  consumed: number,
  requested: number,
  scope: string
): never {
  throw agentError(
    "TUBELESS_AGENT_LIMIT_REACHED",
    `Agent ${name}=${bound} exceeded (consumed=${consumed}, requested=${requested}, scope=${scope})`
  );
}
