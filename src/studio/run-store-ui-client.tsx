import { render } from "preact";
import { StudioApp } from "./run-store-ui-client-app.js";

export { createStudioRunIndex } from "./run-store-ui-client-model.js";

/** Mount the local Studio browser application. */
export function initStudio(): void {
  const root = document.querySelector("#studio-root");
  if (!(root instanceof HTMLElement)) throw new Error("Missing #studio-root");
  render(<StudioApp />, root);
}
