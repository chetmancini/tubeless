import { useEffect, useRef, useState } from "preact/hooks";
import type { StudioTranscriptPage } from "../shared/schema.js";
import type { StudioApi } from "./transport.js";

/** Retain successful pages on failure and retire requests when the selected run changes. */
export function useTranscript(load: NonNullable<StudioApi["loadTranscript"]>, runId: string) {
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [result, setResult] = useState<StudioTranscriptPage>();
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
        setResult((previous) => ({
          ...next,
          transcript: {
            ...next.transcript,
            records:
              afterSequence && previous
                ? [...previous.transcript.records, ...next.transcript.records]
                : next.transcript.records,
          },
          turnRuns:
            afterSequence && previous ? { ...previous.turnRuns, ...next.turnRuns } : next.turnRuns,
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
    setResult(undefined);
    request();
    return () => {
      generation.current++;
    };
  }, [load, runId]);
  return {
    page: result?.transcript,
    turnRuns: result?.turnRuns ?? {},
    loading,
    error,
    more: () => {
      if (!loading) request(result?.transcript.nextSequence ?? 0);
    },
  };
}
