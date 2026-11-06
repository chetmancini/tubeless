import { useEffect } from "preact/hooks";

/** A modal owns Escape even while busy; inspectors defer to claimed key events. */
export function useEscapeDismiss(
  onClose: () => void,
  { active = true, blocked = false, modal = false } = {}
) {
  useEffect(() => {
    if (!active) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (modal) event.preventDefault();
      if (!blocked) onClose();
    };
    document.addEventListener("keydown", handleEscape, modal);
    return () => document.removeEventListener("keydown", handleEscape, modal);
  }, [active, blocked, modal, onClose]);
}
