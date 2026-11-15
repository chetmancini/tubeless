import { useEffect, useRef, useState } from "preact/hooks";
import type { StudioTranscriptPage } from "../shared/schema.js";
import type { StudioApi } from "./transport.js";

export const TRANSCRIPT_REFRESH_MS = 1_200;
type TranscriptApi = Pick<StudioApi, "loadTranscript" | "subscribeAccessDenied">;
interface TranscriptState {
  api?: TranscriptApi;
  runId: string;
  result?: StudioTranscriptPage;
  loading: boolean;
  error?: string;
}

/** One visible conversation owns its requests, pagination and mutable-source refresh timer. */
export function useTranscript(api: TranscriptApi, runId: string) {
  const actions = useRef<{ api: TranscriptApi; runId: string; more(): void } | undefined>(
    undefined
  );
  const [state, setState] = useState<TranscriptState>({ runId: "", loading: true });
  useEffect(() => {
    let active = true;
    let result: StudioTranscriptPage | undefined;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => typeof document !== "undefined" && document.hidden;
    const publish = (loading: boolean, error?: string) =>
      setState({ api, runId, result, loading, error });
    const cursor = () => result?.transcript.records.at(-1)?.sequence ?? 0;
    const refreshable = () =>
      result?.live && ["partial", "unavailable"].includes(result.transcript.status);
    const retire = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      request?.abort();
      request = undefined;
    };
    const load = () => {
      if (!active || request || hidden()) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const current = (request = new AbortController());
      const afterSequence = cursor();
      publish(true);
      void api.loadTranscript(runId, afterSequence, current.signal).then(
        (next) => {
          if (!active || request !== current) return;
          request = undefined;
          if (result && result.sourceId !== next.sourceId) {
            // A replacement source cannot inherit another source's content or cursor.
            result = undefined;
            load();
            return;
          }
          result = {
            ...next,
            transcript: {
              ...next.transcript,
              records: [...(result?.transcript.records ?? []), ...next.transcript.records],
            },
            turnRuns: { ...result?.turnRuns, ...next.turnRuns },
          };
          publish(false);
          if (refreshable() && !hidden()) timer = setTimeout(load, TRANSCRIPT_REFRESH_MS);
        },
        (cause: unknown) => {
          if (!active || request !== current) return;
          request = undefined;
          // Keep successful pages without scheduling another request.
          publish(false, cause instanceof Error ? cause.message : "Could not load transcript.");
        }
      );
    };
    const visibility = () => {
      if (!active) return;
      if (hidden()) {
        retire();
        publish(false);
      } else if (!result || refreshable()) load();
    };
    actions.current = { api, runId, more: load };
    publish(true);
    const unsubscribe = api.subscribeAccessDenied?.((status) => {
      active = false;
      retire();
      result = undefined;
      publish(false, status === 401 ? "Sign in to continue." : "Access denied.");
    });
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
    load();
    return () => {
      active = false;
      retire();
      unsubscribe?.();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibility);
    };
  }, [api, runId]);
  const current = state.api === api && state.runId === runId;
  return {
    page: current ? state.result?.transcript : undefined,
    turnRuns: current ? (state.result?.turnRuns ?? {}) : {},
    loading: !current || state.loading,
    error: current ? state.error : undefined,
    more() {
      const action = actions.current;
      if (action?.api === api && action.runId === runId) action.more();
    },
  };
}
