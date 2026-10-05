import { STUDIO_HISTORY_PAGE_SIZE } from "./run-store-ui-schema.js";
import type { StoredDefinitionSummary } from "../run-store/run-history.js";
import type { StudioApi, StudioDefinitionDetail } from "./run-store-ui-client-transport.js";
import { MetadataDetails, MetadataExplorer } from "./run-store-ui-metadata.js";
import { useEffect, useState } from "preact/hooks";
import { compareDefinitions } from "../run-store/definition-diff.js";
import type { StoredPipelineDefinition } from "../run-store/run-store.js";

function key(definition: StoredDefinitionSummary): string {
  return JSON.stringify([definition.pipelineId, definition.identity?.definitionId ?? null]);
}

function label(definition: StoredDefinitionSummary): string {
  const identity = definition.identity;
  return `${definition.pipelineId} · ${identity ? identity.definitionId.slice(7, 19) : "Legacy (identity not recorded)"} · ${identity?.implementationVersion ?? "implementation unknown"} · ${definition.runCount} ${definition.runCount === 1 ? "run" : "runs"}`;
}

export function DefinitionHistoryView({
  definitions,
  selectedKey,
  compareKey,
  detail,
  comparison,
  error,
  onDefinition,
  onCompare,
  onPage,
  onSelect,
}: {
  definitions: readonly StoredDefinitionSummary[];
  selectedKey: string;
  compareKey: string;
  detail: StudioDefinitionDetail | null;
  comparison: StoredPipelineDefinition | null;
  error?: string;
  onDefinition(key: string): void;
  onCompare(key: string): void;
  onPage(offset: number): void;
  onSelect(runId: string): void;
}) {
  const selected =
    definitions.find((definition) => key(definition) === selectedKey) ?? definitions[0];
  if (!selected) return null;
  const candidates = definitions.filter(
    (definition) =>
      definition.pipelineId === selected.pipelineId && key(definition) !== key(selected)
  );
  const previous = candidates.find((definition) => key(definition) === compareKey) ?? candidates[0];
  const snapshot = detail?.definition.snapshot;
  const groupedRuns = detail?.runs ?? [];
  const changes =
    comparison?.snapshot && snapshot
      ? compareDefinitions(comparison.snapshot, snapshot)
      : undefined;
  return (
    <section class="sheet definition-history">
      <div class="sheet-head">
        <div>
          <div class="sheet-title">Observed definitions</div>
          <div class="sheet-subtitle">
            Graph fingerprints do not verify handler code. Implementation versions are supplied by
            the application.
          </div>
        </div>
      </div>
      <div class="definition-body">
        <label class="field">
          Definition{" "}
          <select
            aria-label="Definition"
            value={key(selected)}
            onChange={(event) => {
              onDefinition(event.currentTarget.value);
            }}
          >
            {definitions.map((definition) => (
              <option key={key(definition)} value={key(definition)}>
                {label(definition)}
              </option>
            ))}
          </select>
        </label>
        {selected.identity && (
          <p class="definition-identity">
            Structural fingerprint: <code>{selected.identity.structuralFingerprint}</code>
            <br />
            Definition ID: <code>{selected.identity.definitionId}</code>
          </p>
        )}
        {snapshot && (
          <>
            <MetadataDetails metadata={snapshot.metadata} />
            <MetadataExplorer key={key(selected)} steps={snapshot.steps} />
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {!detail && !error && <p>Loading definition…</p>}
        <details>
          <summary>Runs with this definition ({selected.runCount})</summary>
          <ul>
            {groupedRuns.map((run) => (
              <li key={run.runId}>
                <button type="button" onClick={() => onSelect(run.runId)}>
                  {run.status} · {new Date(run.startedAtMs).toLocaleString()} · {run.runId}
                </button>
              </li>
            ))}
          </ul>
          {detail && detail.runCount > STUDIO_HISTORY_PAGE_SIZE && (
            <div class="confirm-actions">
              <button
                class="secondary-button"
                disabled={!detail.offset}
                onClick={() => onPage(Math.max(0, detail.offset - STUDIO_HISTORY_PAGE_SIZE))}
              >
                Previous
              </button>
              <span>
                {detail.offset + 1}–{detail.offset + groupedRuns.length} of {detail.runCount}
              </span>
              <button
                class="secondary-button"
                disabled={detail.offset + STUDIO_HISTORY_PAGE_SIZE >= detail.runCount}
                onClick={() => onPage(detail.offset + STUDIO_HISTORY_PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          )}
        </details>
        {previous ? (
          <>
            <label class="field">
              Compare from{" "}
              <select
                aria-label="Compare from"
                value={key(previous)}
                onChange={(event) => onCompare(event.currentTarget.value)}
              >
                {candidates.map((definition) => (
                  <option key={key(definition)} value={key(definition)}>
                    {label(definition)}
                  </option>
                ))}
              </select>
            </label>
            <p class="sheet-subtitle">
              Changes from the comparison definition to the selected definition.
            </p>
            {!comparison || !detail ? (
              <p>Loading comparison…</p>
            ) : changes ? (
              changes.length ? (
                <ul class="definition-changes">
                  {changes.map((change, index) => (
                    <li key={index}>
                      <strong>
                        {change.stepId ? `${change.stepId}: ` : ""}
                        {change.field}
                      </strong>
                      {(change.before !== undefined || change.after !== undefined) && (
                        <div>
                          <code>{change.before ?? "not supplied"}</code> →{" "}
                          <code>{change.after ?? "not supplied"}</code>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No recorded semantic changes.</p>
              )
            ) : (
              <p>
                A complete comparison is unavailable: a legacy recording has no identity, or a
                definition snapshot exceeded recording limits.
              </p>
            )}
          </>
        ) : (
          <p class="sheet-subtitle">
            Record another version of this pipeline to compare definitions.
          </p>
        )}
      </div>
    </section>
  );
}

function useDefinitionDetail(
  api: StudioApi | undefined,
  definition: StoredDefinitionSummary | undefined,
  offset: number
): { detail: StudioDefinitionDetail | null; error?: string } {
  const [result, setResult] = useState<{
    requestKey: string;
    detail: StudioDefinitionDetail | null;
    error?: string;
  }>({
    requestKey: "",
    detail: null,
  });
  const pipelineId = definition?.pipelineId;
  const definitionId = definition?.identity?.definitionId;
  const fingerprint = definition
    ? [definition.runCount, definition.activeRuns, definition.lastSeenAtMs].join(":")
    : "";
  const requestKey = JSON.stringify([pipelineId, definitionId, fingerprint, offset]);
  useEffect(() => {
    let current = true;
    setResult({ requestKey, detail: null });
    if (api && pipelineId) {
      void api.loadDefinition(pipelineId, definitionId, offset).then(
        (detail) => {
          if (current) setResult({ requestKey, detail });
        },
        (error: unknown) => {
          if (current)
            setResult({
              requestKey,
              detail: null,
              error: error instanceof Error ? error.message : "Could not load definition.",
            });
        }
      );
    }
    return () => {
      current = false;
    };
  }, [api, pipelineId, definitionId, fingerprint, offset, requestKey]);
  return result.requestKey === requestKey ? result : { detail: null };
}

export function DefinitionHistory({
  definitions,
  api,
  onSelect,
}: {
  definitions: readonly StoredDefinitionSummary[];
  api?: StudioApi;
  onSelect(runId: string): void;
}) {
  const [selectedKey, setSelectedKey] = useState("");
  const [compareKey, setCompareKey] = useState("");
  const [offset, setOffset] = useState(0);
  const selected = definitions.find((entry) => key(entry) === selectedKey) ?? definitions[0];
  const candidates = definitions.filter(
    (entry) =>
      entry.pipelineId === selected?.pipelineId && key(entry) !== (selected && key(selected))
  );
  const previous = candidates.find((entry) => key(entry) === compareKey) ?? candidates[0];
  const result = useDefinitionDetail(api, selected, offset);
  const comparison = useDefinitionDetail(api, previous, 0);
  return (
    <DefinitionHistoryView
      definitions={definitions}
      selectedKey={selectedKey}
      compareKey={compareKey}
      detail={result.detail}
      comparison={comparison.detail?.definition ?? null}
      error={result.error ?? comparison.error}
      onDefinition={(value) => {
        setSelectedKey(value);
        setCompareKey("");
        setOffset(0);
      }}
      onCompare={setCompareKey}
      onPage={setOffset}
      onSelect={onSelect}
    />
  );
}
