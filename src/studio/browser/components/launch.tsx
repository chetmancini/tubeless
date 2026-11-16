import type { TargetedEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CliParameterDescriptor } from "../../../cli/cli.js";
import type { PipelinePlan } from "../../../core/pipeline.js";
import type { StudioApi } from "../transport.js";
import type { PipelineRunStudioCommand } from "../../shared/protocol.js";
import { commandDescription, errorMessage } from "./common.js";
import { PlanView } from "./pipelines.js";
import { useEscapeDismiss } from "../escape-dismiss.js";
import {
  createStudioLaunchForm,
  serializeLaunchValues,
  serializePlanInput,
  type StudioLaunchForm,
  type StudioParameterValue,
} from "../launch-form.js";
import type { StudioLaunchMetadata } from "../../shared/launch-metadata.js";

function parameterLabel(parameter: CliParameterDescriptor): string {
  return parameter.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parameterHint(parameter: CliParameterDescriptor): string {
  const details = [];
  if (parameter.description) details.push(parameter.description);
  if (parameter.environment) details.push("Environment fallback: " + parameter.environment);
  if (parameter.multiple)
    details.push(parameter.choices ? "Choose one or more values." : "Enter one value per line.");
  if (parameter.mustExist)
    details.push("Must be an existing " + (parameter.pathKind || "path") + ".");
  return details.join(" ");
}

interface ParameterControlProps {
  index: number;
  onChange(index: number, values: StudioParameterValue[]): void;
  parameter: CliParameterDescriptor;
  values: readonly StudioParameterValue[];
}

function ParameterControl({ index, onChange, parameter, values }: ParameterControlProps) {
  const id = "run-param-" + index;
  const hint = parameterHint(parameter);
  const label = parameterLabel(parameter);
  if (parameter.type === "boolean") {
    return (
      <label class="boolean-field" for={id}>
        <span>
          <strong>{label}</strong>
          <small>{hint || "Enable this option."}</small>
        </span>
        <input
          id={id}
          type="checkbox"
          checked={values[0] === true}
          onChange={(event) => onChange(index, [event.currentTarget.checked])}
        />
      </label>
    );
  }
  const fieldLabel = (
    <label for={id}>
      {label}
      {parameter.required && <span class="required-mark">required</span>}
    </label>
  );
  let control;
  if (parameter.choices) {
    const selectedValues = values.filter((value): value is string => typeof value === "string");
    control = (
      <select
        id={id}
        multiple={parameter.multiple}
        required={parameter.required}
        value={parameter.multiple ? undefined : (selectedValues[0] ?? "")}
        onChange={(event: TargetedEvent<HTMLSelectElement>) =>
          onChange(
            index,
            parameter.multiple
              ? Array.from(event.currentTarget.selectedOptions, (option) => option.value)
              : [event.currentTarget.value]
          )
        }
      >
        {!parameter.multiple && (
          <option value="" disabled={parameter.required}>
            {parameter.required ? "Choose a value" : "Use default or leave unset"}
          </option>
        )}
        {parameter.choices.map((choice) => (
          <option
            key={choice}
            value={choice}
            selected={parameter.multiple ? selectedValues.includes(choice) : undefined}
          >
            {choice}
          </option>
        ))}
      </select>
    );
  } else if (parameter.multiple) {
    control = (
      <textarea
        id={id}
        spellcheck={false}
        placeholder="One value per line"
        value={String(values[0] ?? "")}
        onInput={(event) => onChange(index, [event.currentTarget.value])}
      />
    );
  } else if (parameter.type === "number") {
    const inputValue = values[0] ?? "";
    control = (
      <input
        id={id}
        type="number"
        value={String(inputValue)}
        step={parameter.integer ? "1" : "any"}
        min={parameter.min}
        max={parameter.max}
        required={parameter.required}
        onInput={(event) =>
          onChange(
            index,
            event.currentTarget.value !== ""
              ? [Number(event.currentTarget.value)]
              : [event.currentTarget.value]
          )
        }
      />
    );
  } else {
    const inputValue = values[0] ?? "";
    control = (
      <input
        id={id}
        type="text"
        value={String(inputValue)}
        placeholder={
          parameter.type === "path"
            ? parameter.pathKind === "directory"
              ? "./directory"
              : "./file"
            : ""
        }
        required={parameter.required}
        onInput={(event) => onChange(index, [event.currentTarget.value])}
      />
    );
  }
  return (
    <div class="field">
      {fieldLabel}
      {control}
      {hint && <div class="field-hint">{hint}</div>}
    </div>
  );
}

interface CommandFieldsProps {
  command: PipelineRunStudioCommand;
  onChange(index: number, values: StudioParameterValue[]): void;
  values: readonly (readonly StudioParameterValue[])[];
}

export function CommandFields({ command, onChange, values }: CommandFieldsProps) {
  const renderSection = (execution: boolean, title: string, note: string) => {
    const parameters = command.parameters
      .map((parameter, index) => ({ index, parameter }))
      .filter(({ parameter }) => (parameter.group === "execution") === execution);
    if (!parameters.length) return null;
    const grid = (
      <div class="parameter-grid">
        {parameters.map(({ index, parameter }) => (
          <ParameterControl
            key={parameter.key}
            index={index}
            onChange={onChange}
            parameter={parameter}
            values={values[index] ?? []}
          />
        ))}
      </div>
    );
    return execution ? (
      <details class="form-section execution-controls">
        <summary class="form-section-head">
          <strong>{title}</strong>
          <span>{note}</span>
        </summary>
        {grid}
      </details>
    ) : (
      <section class="form-section">
        <div class="form-section-head">
          <strong>{title}</strong>
          <span>{note}</span>
        </div>
        {grid}
      </section>
    );
  };
  const domainCount = command.parameters.filter(
    (parameter) => parameter.group !== "execution"
  ).length;
  return (
    <div class="parameter-fields" id="parameterFields">
      {renderSection(
        false,
        "Pipeline inputs",
        domainCount + " parameter" + (domainCount === 1 ? "" : "s")
      )}
      {domainCount === 0 && <p class="form-empty">This pipeline takes no inputs.</p>}
      {renderSection(
        true,
        "Execution controls",
        "Built into Tubeless · dry run, step selection, cache, concurrency"
      )}
    </div>
  );
}

interface LaunchModalProps {
  api: StudioApi;
  commands: readonly PipelineRunStudioCommand[];
  commandId: string;
  previousLaunch?: StudioLaunchMetadata;
  onClose(): void;
  /** Receives the new run and the command (pipeline) that started it. */
  onLaunched(runId: string, commandId: string): void;
}

export function LaunchModal({
  api,
  commands,
  commandId,
  previousLaunch,
  onClose,
  onLaunched,
}: LaunchModalProps) {
  const [selectedId, setSelectedId] = useState(commandId);
  const command = commands.find((candidate) => candidate.id === selectedId);
  const [form, setForm] = useState<StudioLaunchForm>(() =>
    command ? createStudioLaunchForm(command, previousLaunch) : { values: [], emptyKeys: new Set() }
  );
  const [plan, setPlan] = useState<PipelinePlan | null>(null);
  const [error, setError] = useState("");
  const [launching, setLaunching] = useState(false);
  const [planning, setPlanning] = useState(false);
  const firstField = useRef<HTMLDivElement>(null);
  const planVersion = useRef(0);

  useEffect(() => {
    setSelectedId(commandId);
  }, [commandId, commands]);

  useEffect(() => {
    planVersion.current += 1;
    setForm(
      command
        ? createStudioLaunchForm(command, previousLaunch)
        : { values: [], emptyKeys: new Set() }
    );
    setPlan(null);
    setError("");
    requestAnimationFrame(() =>
      firstField.current?.querySelector<HTMLElement>("input, select, textarea")?.focus()
    );
  }, [command, previousLaunch]);

  useEscapeDismiss(onClose, {
    blocked: launching || planning,
    modal: true,
  });

  const close = () => {
    if (!launching && !planning) onClose();
  };
  const updateValue = (index: number, next: StudioParameterValue[]) => {
    if (!command) return;
    planVersion.current += 1;
    setForm((current) => ({
      ...current,
      values: current.values.map((value, candidateIndex) => {
        if (candidateIndex === index) return next;
        const parameter = command.parameters[candidateIndex];
        return command.parameters[index]?.exclusive &&
          command.parameters[index]?.multiple &&
          next.length > 0 &&
          parameter?.exclusive &&
          parameter.multiple
          ? []
          : value;
      }),
    }));
    setPlan(null);
  };
  const preview = async () => {
    if (!command?.canPlan || planning) return;
    const requestedVersion = planVersion.current;
    setPlanning(true);
    setError("");
    try {
      const nextPlan = await api.previewPlan(command.id, serializePlanInput(command, form));
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
      onLaunched(await api.launch(command.id, serializeLaunchValues(command, form)), command.id);
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
        <form
          class="launch-form"
          onSubmit={launch}
          onInvalidCapture={(event) => {
            // Reveal a folded section so the browser can show its validation message.
            const field = event.target instanceof HTMLElement ? event.target : null;
            field?.closest("details")?.setAttribute("open", "");
          }}
        >
          {form.review && (
            <div class="field-hint" role="status">
              Review the saved inputs and supply any missing required values. This creates a new
              launch.
              {form.review.definitionChanged && (
                <p>
                  The pipeline definition changed or could not be compared. This run will use the
                  current definition.
                </p>
              )}
              {form.review.skipped.length > 0 && (
                <p>
                  Saved inputs no longer compatible with this command were left blank:{" "}
                  {form.review.skipped.join(", ")}.
                </p>
              )}
            </div>
          )}
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
            {command && (
              <CommandFields command={command} onChange={updateValue} values={form.values} />
            )}
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
