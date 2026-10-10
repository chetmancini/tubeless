import type { AgentToolContext } from "./agent-types.js";

export interface ToolActivityFormat<TInput = unknown, TResult = unknown> {
  action(input: TInput): string;
  summarize(result: TResult): string;
}

export interface ToolActivity {
  readonly action: string;
  complete(result: unknown): string;
}

/** Keep paths, queries, and commands single-line and bounded; never preview file contents. */
export function toolPreview(value: string): string {
  const preview = JSON.stringify(value.length > 160 ? `${value.slice(0, 159)}…` : value);
  return preview.replace(
    /[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** Start in the handler; settle only when the dispatcher receives the validated outcome. */
export function startToolActivity(
  format: ToolActivityFormat,
  input: unknown,
  context: AgentToolContext
): ToolActivity {
  const action = format.action(input);
  context.reportProgress({ completed: 0, total: 1, message: action });
  context.log.log(action);
  return {
    action,
    complete(result) {
      return `${action}: completed (${format.summarize(result)})`;
    },
  };
}
