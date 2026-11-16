/** A handler may throw this error to return a recoverable observation to its agent. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ToolError";
    if (!code.trim() || code.length > 256 || message.length > 4096)
      throw new Error(
        "ToolError requires a nonblank code (up to 256 characters) and a message of at most 4096 characters"
      );
  }
}
