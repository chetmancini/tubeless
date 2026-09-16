import { useEffect, useRef, useState } from "preact/hooks";
import type { CliParameterDescriptor } from "../cli/cli.js";
import type { PipelinePlan } from "../core/pipeline.js";
import { CommandFields, commandDescription, PlanView } from "./run-store-ui-client-commands.js";
import {
  initialStudioParameterValues,
  serializeLaunchValues,
  serializePlanInput,
  type StudioParameterValue,
} from "./run-store-ui-client-form.js";
import type { StudioSnapshot } from "./run-store-ui-client-model.js";
import type { StudioApi } from "./run-store-ui-client-transport.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message || String(error) : String(error);
}

interface LaunchModalProps {
  api: StudioApi;
  commands: readonly PipelineRunStudioCommand[];
  commandId: string | null;
  onClose(): void;
  onLaunched(runId: string): void;
}

export function LaunchModal({ api, commands, commandId, onClose, onLaunched }: LaunchModalProps) {
  const [selectedId, setSelectedId] = useState(commandId ?? commands[0]?.id ?? "");
  const command = commands.find((candidate) => candidate.id === selectedId);
  const [values, setValues] = useState<StudioParameterValue[][]>([]);
  const [plan, setPlan] = useState<PipelinePlan | null>(null);
  const [error, setError] = useState("");
  const [launching, setLaunching] = useState(false);
  const [planning, setPlanning] = useState(false);
  const firstField = useRef<HTMLDivElement>(null);
  const planVersion = useRef(0);

  useEffect(() => {
    setSelectedId(commandId ?? commands[0]?.id ?? "");
  }, [commandId, commands]);

  useEffect(() => {
    planVersion.current += 1;
    setValues(command ? initialStudioParameterValues(command) : []);
    setPlan(null);
    setError("");
    requestAnimationFrame(() =>
      firstField.current?.querySelector<HTMLElement>("input, select, textarea")?.focus()
    );
  }, [command]);

  useEffect(() => {
    if (commandId === null) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !launching && !planning) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [commandId, launching, onClose, planning]);

  if (commandId === null) return null;

  const close = () => {
    if (!launching && !planning) onClose();
  };
  const updateValue = (index: number, next: StudioParameterValue[]) => {
    if (!command) return;
    planVersion.current += 1;
    setValues((current) =>
      current.map((value, candidateIndex) => {
        if (candidateIndex === index) return next;
        const parameter = command.parameters[candidateIndex];
        return command.parameters[index]?.exclusive &&
          command.parameters[index]?.multiple &&
          next.length > 0 &&
          parameter?.exclusive &&
          parameter.multiple
          ? []
          : value;
      })
    );
    setPlan(null);
  };
  const readValues = (parameter: CliParameterDescriptor, index: number) => {
    const stored = values[index] ?? [];
    if (!parameter.multiple || parameter.choices) return stored;
    return String(stored[0] ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (parameter.type === "number" ? Number(value) : value));
  };
  const preview = async () => {
    if (!command?.canPlan || planning) return;
    const requestedVersion = planVersion.current;
    setPlanning(true);
    setError("");
    try {
      const nextPlan = await api.previewPlan(command.id, serializePlanInput(command, readValues));
      if (planVersion.current === requestedVersion) setPlan(nextPlan);
    } catch (caught) {
      if (planVersion.current === requestedVersion) setError(errorMessage(caught));
    } finally {
      setPlanning(false);
    }
  };
  const launch = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!command || launching) return;
    setLaunching(true);
    setError("");
    try {
      onLaunched(await api.launch(command.id, serializeLaunchValues(command, readValues)));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLaunching(false);
    }
  };
  return (
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="launchTitle"
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <div class="modal">
        <div class="modal-head">
          <div>
            <div class="detail-kicker">Configure pipeline</div>
            <h2 id="launchTitle">{command?.name || "Run a pipeline"}</h2>
            <p>
              {command
                ? commandDescription(command)
                : "Choose a declared pipeline and provide its inputs."}
            </p>
          </div>
          <button class="close-button" type="button" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <form class="launch-form" onSubmit={launch}>
          <div class="field">
            <label for="launchCommand">Pipeline command</label>
            <select
              id="launchCommand"
              value={selectedId}
              onChange={(event) => {
                planVersion.current += 1;
                setPlan(null);
                setError("");
                setSelectedId(event.currentTarget.value);
              }}
            >
              {commands.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
          <div ref={firstField}>
            {command && <CommandFields command={command} onChange={updateValue} values={values} />}
          </div>
          {plan && (
            <div class="plan-result" aria-live="polite">
              <PlanView plan={plan} />
            </div>
          )}
          {error && <div class="launch-error">{error}</div>}
          <div class="modal-actions">
            <button class="secondary-button" type="button" onClick={close}>
              Cancel
            </button>
            {command?.canPlan && (
              <button
                class="secondary-button"
                type="button"
                disabled={planning || launching}
                onClick={() => void preview()}
              >
                {planning ? "Planning…" : "Preview plan"}
              </button>
            )}
            <button class="primary-button" type="submit" disabled={launching || planning}>
              {launching ? "Starting…" : "Run"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ClearHistoryModalProps {
  api: StudioApi;
  onCleared(eventCount: number): void;
  onClose(): void;
  snapshot: StudioSnapshot;
}

export function ClearHistoryModal({ api, onCleared, onClose, snapshot }: ClearHistoryModalProps) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmButton.current?.focus(), []);
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !clearing) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [clearing, onClose]);
  const runCount = snapshot.runs.length;
  const eventCount = snapshot.runs.reduce((total, run) => total + run.eventCount, 0);
  const close = () => {
    if (!clearing) onClose();
  };
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    setError("");
    try {
      onCleared((await api.clearHistory()).eventCount);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setClearing(false);
    }
  };
  return (
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clearHistoryTitle"
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <div class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <div class="detail-kicker">Local maintenance</div>
            <h2 id="clearHistoryTitle">Clear run history?</h2>
            <p>This permanently resets the local studio history.</p>
          </div>
          <button class="close-button" type="button" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <div class="confirm-body">
          <p class="confirm-copy">
            Remove {runCount} recorded run{runCount === 1 ? "" : "s"} and {eventCount} event
            {eventCount === 1 ? "" : "s"} from this SQLite store.
            {snapshot.activeRunCount
              ? ` ${snapshot.activeRunCount} recorded run${
                  snapshot.activeRunCount === 1 ? " is" : "s are"
                } still marked active; continue only if no external process is writing to this store.`
              : ""}
          </p>
          <div class="confirm-warning">
            This cannot be undone. Pipeline definitions and execution remain unchanged; only
            recorded local events are removed.
          </div>
          {error && <div class="launch-error">{error}</div>}
          <div class="confirm-actions">
            <button class="secondary-button" type="button" onClick={close}>
              Cancel
            </button>
            <button
              ref={confirmButton}
              class="danger-button"
              type="button"
              disabled={clearing}
              onClick={() => void clear()}
            >
              {clearing ? "Clearing…" : "Clear history"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
