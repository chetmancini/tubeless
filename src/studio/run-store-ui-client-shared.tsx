import type { ComponentChildren } from "preact";

export const shortId = (id: string) => (id.length > 24 ? id.slice(0, 12) + "…" + id.slice(-7) : id);

export function duration(ms: number | null | undefined): string {
  return ms == null
    ? "—"
    : ms < 1000
      ? Math.max(0, Math.round(ms)) + " ms"
      : ms < 60000
        ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s"
        : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}

export function clock(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

export function dateTime(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    ms
  );
}

export function isoTime(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Date(ms).toISOString();
}

export function relativeTime(ms: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - ms);
  if (delta < 60000) return Math.floor(delta / 1000) + "s ago";
  if (delta < 3600000) return Math.floor(delta / 60000) + "m ago";
  if (delta < 86400000) return Math.floor(delta / 3600000) + "h ago";
  return Math.floor(delta / 86400000) + "d ago";
}

function statusMark(value: string): string {
  return value === "completed"
    ? "✓"
    : value === "skipped"
      ? "×"
      : value === "cancelled"
        ? "■"
        : value === "failed"
          ? "!"
          : value === "planned"
            ? "…"
            : "";
}

export function Status({ value }: { value: string }) {
  return (
    <span class={`status ${value}`}>
      <i class="status-mark" aria-hidden="true">
        {statusMark(value)}
      </i>
      {value}
    </span>
  );
}

export function EmptyView({ copy, title }: { copy: string; title: string }) {
  return (
    <div class="empty">
      <div>
        <div class="empty-icon">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="M4 5.5h12M4 10h12M4 14.5h8" />
          </svg>
        </div>
        <strong>{title}</strong>
        <p>{copy}</p>
      </div>
    </div>
  );
}

interface NestedDetailProps {
  children?: ComponentChildren;
  label: string;
  secondary?: string;
  stepIds?: readonly string[];
}

export function NestedDetail({ children, label, secondary, stepIds }: NestedDetailProps) {
  return (
    <div class="plan-nested">
      <strong>{label}</strong>
      {secondary && <span>{secondary}</span>}
      {stepIds?.map((stepId) => (
        <code key={stepId}>{stepId}</code>
      ))}
      {children}
    </div>
  );
}
