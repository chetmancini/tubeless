import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEscapeDismiss } from "./escape-dismiss.js";

const roots: Element[] = [];
let dispatchKey: (key: string, prevented?: boolean) => Event;

beforeEach(() => {
  const capture = new EventTarget();
  const bubble = new EventTarget();
  vi.stubGlobal("document", {
    addEventListener(type: string, listener: EventListener, useCapture = false) {
      (useCapture ? capture : bubble).addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: EventListener, useCapture = false) {
      (useCapture ? capture : bubble).removeEventListener(type, listener);
    },
  });
  dispatchKey = (key, prevented = false) => {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    if (prevented) event.preventDefault();
    capture.dispatchEvent(event);
    bubble.dispatchEvent(event);
    return event;
  };
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => render(null, root));
  vi.unstubAllGlobals();
});

type DismissOptions = NonNullable<Parameters<typeof useEscapeDismiss>[1]>;

async function mountDismiss(onClose: () => void, initial: DismissOptions = {}) {
  // SAFETY: the probe renders no DOM nodes, so Preact only needs root metadata.
  const root = {
    nodeType: 1,
    firstChild: null,
    namespaceURI: "http://www.w3.org/1999/xhtml",
  } as unknown as Element;
  roots.push(root);
  function Probe({ options }: { options: DismissOptions }) {
    useEscapeDismiss(onClose, options);
    return null;
  }
  const mounted = {
    async update(options: DismissOptions) {
      await act(() => render(<Probe options={options} />, root));
    },
    async unmount() {
      await act(() => render(null, root));
    },
  };
  await mounted.update(initial);
  return mounted;
}

describe("overlay Escape dismissal", () => {
  it("dismisses an inspector only for an unclaimed Escape", async () => {
    const close = vi.fn();
    await mountDismiss(close);

    dispatchKey("Enter");
    dispatchKey("Escape", true);
    expect(close).not.toHaveBeenCalled();
    dispatchKey("Escape");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "gives a modal priority when mounted before the inspector: %s",
    async (modalFirst) => {
      const closeModal = vi.fn();
      const closeInspector = vi.fn();
      const mountModal = () => mountDismiss(closeModal, { modal: true });
      const mountInspector = () => mountDismiss(closeInspector);
      if (modalFirst) {
        await mountModal();
        await mountInspector();
      } else {
        await mountInspector();
        await mountModal();
      }

      expect(dispatchKey("Escape").defaultPrevented).toBe(true);
      expect(closeModal).toHaveBeenCalledTimes(1);
      expect(closeInspector).not.toHaveBeenCalled();
    }
  );

  it("keeps a busy modal's Escape from dismissing the inspector", async () => {
    const closeInspector = vi.fn();
    const closeModal = vi.fn();
    await mountDismiss(closeInspector);
    const modal = await mountDismiss(closeModal, { modal: true, blocked: true });

    expect(dispatchKey("Escape").defaultPrevented).toBe(true);
    expect(closeModal).not.toHaveBeenCalled();
    expect(closeInspector).not.toHaveBeenCalled();

    await modal.update({ modal: true, blocked: false });
    dispatchKey("Escape");
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closeInspector).not.toHaveBeenCalled();
  });

  it("releases Escape when the modal is inactive or unmounted", async () => {
    const closeInspector = vi.fn();
    const closeModal = vi.fn();
    const inspector = await mountDismiss(closeInspector);
    const modal = await mountDismiss(closeModal, { modal: true, active: false });

    expect(dispatchKey("Escape").defaultPrevented).toBe(false);
    expect(closeInspector).toHaveBeenCalledTimes(1);
    expect(closeModal).not.toHaveBeenCalled();

    await modal.update({ modal: true });
    dispatchKey("Escape");
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closeInspector).toHaveBeenCalledTimes(1);

    await modal.unmount();
    expect(dispatchKey("Escape").defaultPrevented).toBe(false);
    expect(closeInspector).toHaveBeenCalledTimes(2);
    await inspector.unmount();
    dispatchKey("Escape");
    expect(closeInspector).toHaveBeenCalledTimes(2);
    expect(closeModal).toHaveBeenCalledTimes(1);
  });
});
