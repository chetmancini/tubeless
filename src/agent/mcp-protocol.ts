export interface McpMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Inbound traffic: every received message, or a failure that ends the connection. */
export interface McpTransportEvents {
  receive(message: McpMessage): void;
  fail(error: Error): void;
}

/** Carries JSON-RPC messages; the session owns ids, deadlines, replies and lifecycle. */
export interface McpTransport {
  /** Deliver one message; any replies arrive through `receive`. */
  send(message: McpMessage, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export type OpenMcpTransport = (events: McpTransportEvents) => Promise<McpTransport>;

export const MAX_MESSAGE_BYTES = 16_777_216;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse one inbound message, rejecting shapes that cannot be JSON-RPC. */
export function parseMessage(text: string): McpMessage {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    throw new Error("MCP server sent invalid JSON");
  }
  if (!isRecord(message) || message.jsonrpc !== "2.0")
    throw new Error("MCP server sent an invalid JSON-RPC message");
  // SAFETY: the version guard identifies JSON-RPC; fields are checked where they are consumed.
  return message as unknown as McpMessage;
}
