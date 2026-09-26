import { MetadataDetails, MetadataExplorer } from "./run-store-ui-metadata.js";
import { useState } from "preact/hooks";
import { compareDefinitions } from "../run-store/definition-diff.js";
import type { StoredPipelineDefinition, StoredPipelineRun } from "../run-store/run-store.js";

function key(definition: StoredPipelineDefinition): string {
  return JSON.stringify([definition.pipelineId, definition.identity?.definitionId ?? null]);
}

function label(definition: StoredPipelineDefinition): string {
  const identity = definition.identity;
  return `${definition.pipelineId} · ${identity ? identity.definitionId.slice(7, 19) : "Legacy (identity not recorded)"} · ${identity?.implementationVersion ?? "implementation unknown"} · ${definition.runCount} ${definition.runCount === 1 ? "run" : "runs"}`;
}

export function DefinitionHistory({
  definitions,
  runs,
  onSelect,
}: {
  definitions: readonly StoredPipelineDefinition[];
  runs: readonly StoredPipelineRun[];
  onSelect: (runId: string) => void;
}) {
  const [selectedKey, setSelectedKey] = useState("");
  const [compareKey, setCompareKey] = useState("");
  const selected =
    definitions.find((definition) => key(definition) === selectedKey) ?? definitions[0];
  if (!selected) return null;
  const candidates = definitions.filter(
    (definition) =>
      definition.pipelineId === selected.pipelineId && key(definition) !== key(selected)
  );
  const previous = candidates.find((definition) => key(definition) === compareKey) ?? candidates[0];
  const groupedRuns = runs.filter(
    (run) =>
      run.pipelineId === selected.pipelineId &&
      run.definitionIdentity?.definitionId === selected.identity?.definitionId
  );
  const changes =
    previous?.snapshot && selected.snapshot
      ? compareDefinitions(previous.snapshot, selected.snapshot)
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
              setSelectedKey(event.currentTarget.value);
              setCompareKey("");
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
        {selected.snapshot && (
          <>
            <MetadataDetails metadata={selected.snapshot.metadata} />
            <MetadataExplorer key={key(selected)} steps={selected.snapshot.steps} />
          </>
        )}
        <details>
          <summary>Runs with this definition ({groupedRuns.length})</summary>
          <ul>
            {groupedRuns.map((run) => (
              <li key={run.runId}>
                <button type="button" onClick={() => onSelect(run.runId)}>
                  {run.status} · {new Date(run.startedAtMs).toLocaleString()} · {run.runId}
                </button>
              </li>
            ))}
          </ul>
        </details>
        {previous ? (
          <>
            <label class="field">
              Compare from{" "}
              <select
                aria-label="Compare from"
                value={key(previous)}
                onChange={(event) => setCompareKey(event.currentTarget.value)}
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
            {changes ? (
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
