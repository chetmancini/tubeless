import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentTranscriptPage } from "../../tracing/agent-transcript.js";
import type { StudioApi } from "./transport.js";

/** Retain successful pages on failure and retire requests when the selected run changes. */
export function useTranscript(load: NonNullable<StudioApi["loadTranscript"]>, runId: string) {
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [page, setPage] = useState<AgentTranscriptPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const request = (afterSequence = 0) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = generation.current;
    setLoading(true);
    setError(undefined);
    load(runId, afterSequence).then(
      (next) => {
        if (current !== generation.current) return;
        inFlight.current = false;
        setPage((previous) => ({
          ...next,
          records:
            afterSequence && previous ? [...previous.records, ...next.records] : next.records,
        }));
        setLoading(false);
      },
      (cause: unknown) => {
        if (current !== generation.current) return;
        inFlight.current = false;
        setError(cause instanceof Error ? cause.message : "Could not load transcript.");
        setLoading(false);
      }
    );
  };
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setPage(undefined);
    request();
    return () => {
      generation.current++;
    };
  }, [load, runId]);
  return {
    page,
    loading,
    error,
    more: () => {
      if (!loading) request(page?.nextSequence ?? 0);
    },
  };
}
