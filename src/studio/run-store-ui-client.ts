import { createStudioController } from "./run-store-ui-client-controller.js";
import { createStudioState } from "./run-store-ui-client-model.js";

export { createStudioRunIndex } from "./run-store-ui-client-model.js";

/** Browser client for the local studio page. Bundled JS is inlined into the served HTML. */
export function initStudio(): void {
  const controller = createStudioController(createStudioState());
  controller.bind();
  controller.start();
}
