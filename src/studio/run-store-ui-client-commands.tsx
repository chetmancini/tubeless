import type { TargetedEvent } from "preact";
import type { CliParameterDescriptor } from "../cli/cli.js";
import type { PipelinePlan } from "../core/pipeline.js";
import type { StudioParameterValue } from "./run-store-ui-client-form.js";
import { EmptyView, NestedDetail } from "./run-store-ui-client-shared.js";
import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";

export function commandDescription(command: PipelineRunStudioCommand): string {
  return command.description || "Run this typed pipeline command.";
}

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
        {!parameter.multiple && !parameter.required && (
          <option value="">Use default or leave unset</option>
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
  } else {
    const inputValue = values[0] ?? "";
    control = (
      <input
        id={id}
        type={parameter.type === "number" ? "number" : "text"}
        value={String(inputValue)}
        placeholder={
          parameter.type === "path"
            ? parameter.pathKind === "directory"
              ? "./directory"
              : "./file"
            : ""
        }
        step={parameter.type === "number" ? (parameter.integer ? "1" : "any") : undefined}
        min={parameter.type === "number" ? parameter.min : undefined}
        max={parameter.type === "number" ? parameter.max : undefined}
        required={parameter.required}
        onInput={(event) =>
          onChange(
            index,
            parameter.type === "number" && event.currentTarget.value !== ""
              ? [Number(event.currentTarget.value)]
              : [event.currentTarget.value]
          )
        }
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
    return (
      <section class="form-section">
        <div class="form-section-head">
          <strong>{title}</strong>
          <span>{note}</span>
        </div>
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
      {renderSection(true, "Execution controls", "Built into Tubeless")}
    </div>
  );
}

export function PipelinesView({
  commands,
  onConfigure,
}: {
  commands: readonly PipelineRunStudioCommand[];
  onConfigure(id: string): void;
}) {
  if (!commands.length) {
    return (
      <div class="sheet">
        <EmptyView
          title="No pipelines found"
          copy="Try a different pipeline name or description."
        />
      </div>
    );
  }
  return (
    <section class="sheet">
      <div class="sheet-head">
        <div>
          <div class="sheet-title">Available pipelines</div>
          <div class="sheet-subtitle">Declared by the local project manifest</div>
        </div>
        <span class="sheet-subtitle">{commands.length} shown</span>
      </div>
      <div class="catalog">
        {commands.map((command) => (
          <article class="catalog-card" key={command.id}>
            <h3>{command.name}</h3>
            <p>{commandDescription(command)}</p>
            <div class="catalog-actions">
              <button class="primary-button" onClick={() => onConfigure(command.id)}>
                Configure
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function PlanView({ plan }: { plan: PipelinePlan }) {
  const selected = plan.steps.filter((step) => step.selected && !step.skipReason).length;
  return (
    <>
      {plan.errors.length > 0 && (
        <div class="launch-error">
          {plan.errors.map((error) => (
            <div key={error.message}>{error.message}</div>
          ))}
        </div>
      )}
      <div class="plan-summary">
        <strong>{plan.pipelineId}</strong>
        <span>
          {selected} of {plan.steps.length} steps will run{plan.dryRun ? " · dry run" : ""}
        </span>
      </div>
      <div class="plan-steps">
        {plan.steps.map((step) => {
          const disposition = !step.selected
            ? "Not selected"
            : step.skipReason === "dry-run"
              ? "Dry-run skip"
              : step.skipReason
                ? "Skipped"
                : "Will run";
          const detail =
            step.description ||
            (step.dependencies.length
              ? "After " + step.dependencies.join(", ")
              : "No required dependencies");
          const nested = step.nestedPipeline;
          const remote = step.remote;
          const kind = remote
            ? "Remote step"
            : nested
              ? nested.mode === "for-each"
                ? "Pipeline fan-out"
                : "Nested pipeline"
              : "Step";
          return (
            <div class="plan-step" key={step.id}>
              <div class="plan-step-title">
                <strong>{step.name || step.id}</strong>
                <span class={`plan-kind${nested ? " pipeline" : ""}`}>{kind}</span>
              </div>
              <small>{detail}</small>
              <span class={`plan-disposition${disposition === "Will run" ? "" : " skipped"}`}>
                {disposition}
              </span>
              {nested && (
                <NestedDetail
                  label={nested.pipelineId}
                  secondary={`${nested.stepIds.length} declared steps${
                    nested.mode === "for-each" ? " per runtime item" : ""
                  }`}
                  stepIds={nested.stepIds}
                />
              )}
              {remote && <NestedDetail label={remote.engine} secondary={remote.target} />}
            </div>
          );
        })}
      </div>
    </>
  );
}
