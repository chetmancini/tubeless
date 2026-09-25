import { DefinitionHistory } from "./run-store-ui-definitions.js";
import type { ComponentChildren, TargetedEvent } from "preact";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CliParameterDescriptor } from "../cli/cli.js";
import type { PipelinePlan, PipelineRunControls } from "../core/pipeline.js";
import type {
  StoredPipelineDefinition,
  StoredPipelineRun,
  StoredPipelineStep,
} from "../run-store/run-store.js";
import {
  createStudioApi,
  type StudioApi,
  type StudioSnapshot,
} from "./run-store-ui-client-transport.js";
import { StudioDataController } from "./run-store-ui-data-controller.js";
import type {
  PipelineRunStudioCommand,
  PipelineRunStudioLaunchRequest,
} from "./run-store-ui-protocol.js";

const EMPTY_STUDIO_RUNS: readonly StoredPipelineRun[] = [];

export interface StudioRunIndex {
  readonly roots: readonly StoredPipelineRun[];
  ancestorsOf(runId: string | null | undefined): StoredPipelineRun[];
  childrenOf(runId: string): readonly StoredPipelineRun[];
  descendantCount(runId: string): number;
  matchingRootIds(query: string): ReadonlySet<string>;
  rootRunId(runId: string | null | undefined): string | null | undefined;
  runById(runId: string | null | undefined): StoredPipelineRun | undefined;
  subtreeIsRunning(runId: string): boolean;
}

/** Derived run hierarchy for one studio snapshot. Rebuild when the snapshot is replaced. */
export function createStudioRunIndex(runs: readonly StoredPipelineRun[]): StudioRunIndex {
  const runsById = new Map<string, StoredPipelineRun>();
  const childrenByParentId = new Map<string, StoredPipelineRun[]>();
  const parentIdByRunId = new Map<string, string | undefined>();
  for (const run of runs) {
    if (!runsById.has(run.runId)) runsById.set(run.runId, run);
    const parentRunId = run.parentRunId;
    if (!parentIdByRunId.has(run.runId)) parentIdByRunId.set(run.runId, parentRunId);
  }

  // Break one edge per malformed parent cycle so every recorded run remains
  // reachable from a Studio root.
  const resolvedParents = new Set<string>();
  for (const run of runs) {
    if (resolvedParents.has(run.runId)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let currentId: string | undefined = run.runId;
    while (currentId && runsById.has(currentId) && !resolvedParents.has(currentId)) {
      if (onPath.has(currentId)) {
        parentIdByRunId.set(currentId, undefined);
        break;
      }
      onPath.add(currentId);
      path.push(currentId);
      currentId = parentIdByRunId.get(currentId);
    }
    for (const id of path) resolvedParents.add(id);
  }

  for (const run of runs) {
    const parentRunId = parentIdByRunId.get(run.runId);
    if (!parentRunId) continue;
    const siblings = childrenByParentId.get(parentRunId);
    if (siblings) siblings.push(run);
    else childrenByParentId.set(parentRunId, [run]);
  }
  for (const siblings of childrenByParentId.values()) {
    siblings.sort((left, right) => right.startedAtMs - left.startedAtMs);
  }

  const roots: StoredPipelineRun[] = [];
  const rootIds = new Set<string>();
  for (const run of runs) {
    const parentRunId = parentIdByRunId.get(run.runId);
    if (parentRunId && runsById.has(parentRunId)) continue;
    roots.push(run);
    rootIds.add(run.runId);
  }

  const rootIdByRunId = new Map<string, string | undefined>();
  for (const run of runs) {
    if (rootIdByRunId.has(run.runId)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let currentId: string | undefined = run.runId;
    let resolved: string | undefined;
    while (currentId) {
      if (rootIdByRunId.has(currentId)) {
        resolved = rootIdByRunId.get(currentId);
        break;
      }
      if (rootIds.has(currentId)) {
        resolved = currentId;
        break;
      }
      if (onPath.has(currentId)) {
        resolved = undefined;
        break;
      }
      onPath.add(currentId);
      path.push(currentId);
      const parentRunId = parentIdByRunId.get(currentId);
      if (!parentRunId || !runsById.has(parentRunId)) {
        resolved = currentId;
        break;
      }
      currentId = parentRunId;
    }
    if (resolved !== undefined) rootIdByRunId.set(resolved, resolved);
    for (const id of path) rootIdByRunId.set(id, resolved);
  }

  const descendantCountById = new Map<string, number>();
  const subtreeRunningById = new Map<string, boolean>();
  for (const run of runs) {
    if (descendantCountById.has(run.runId)) continue;
    const stack: { exiting: boolean; id: string }[] = [{ exiting: false, id: run.runId }];
    const visiting = new Set<string>();
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      if (frame.exiting) {
        visiting.delete(frame.id);
        let count = 0;
        let running = runsById.get(frame.id)?.status === "running";
        for (const child of childrenByParentId.get(frame.id) ?? EMPTY_STUDIO_RUNS) {
          const childCount = descendantCountById.get(child.runId);
          if (childCount === undefined) continue;
          count += 1 + childCount;
          running = running || subtreeRunningById.get(child.runId) === true;
        }
        descendantCountById.set(frame.id, count);
        subtreeRunningById.set(frame.id, running);
        continue;
      }
      if (descendantCountById.has(frame.id) || visiting.has(frame.id)) continue;
      visiting.add(frame.id);
      stack.push({ exiting: true, id: frame.id });
      for (const child of childrenByParentId.get(frame.id) ?? EMPTY_STUDIO_RUNS) {
        if (!descendantCountById.has(child.runId) && !visiting.has(child.runId)) {
          stack.push({ exiting: false, id: child.runId });
        }
      }
    }
  }

  function runById(runId: string | null | undefined) {
    return runId == null ? undefined : runsById.get(runId);
  }
  function childrenOf(runId: string): readonly StoredPipelineRun[] {
    return childrenByParentId.get(runId) ?? EMPTY_STUDIO_RUNS;
  }
  function ancestorsOf(runId: string | null | undefined) {
    const ancestors: StoredPipelineRun[] = [];
    const seen = new Set<string>();
    let current = runById(runId);
    while (current) {
      const parentRunId = parentIdByRunId.get(current.runId);
      if (!parentRunId || seen.has(parentRunId)) break;
      seen.add(parentRunId);
      const parent = runsById.get(parentRunId);
      if (!parent) break;
      ancestors.unshift(parent);
      current = parent;
    }
    return ancestors;
  }
  function matchingRootIds(query: string): ReadonlySet<string> {
    const needle = query.toLowerCase();
    const matched = new Set<string>();
    if (!needle) {
      for (const root of roots) matched.add(root.runId);
      return matched;
    }
    for (const run of runs) {
      if (
        !run.pipelineId.toLowerCase().includes(needle) &&
        !run.runId.toLowerCase().includes(needle) &&
        !run.correlationId?.toLowerCase().includes(needle)
      ) {
        continue;
      }
      const rootId = rootIdByRunId.get(run.runId);
      if (rootId) matched.add(rootId);
    }
    return matched;
  }

  return {
    roots,
    ancestorsOf,
    childrenOf,
    descendantCount(runId: string) {
      return descendantCountById.get(runId) ?? 0;
    },
    matchingRootIds,
    rootRunId(runId: string | null | undefined) {
      return runId == null ? runId : (rootIdByRunId.get(runId) ?? runId);
    },
    runById,
    subtreeIsRunning(runId: string) {
      return subtreeRunningById.get(runId) === true;
    },
  };
}

export type StudioParameterValue = boolean | number | string;

export type ReadStudioParameterValues = (
  parameter: CliParameterDescriptor,
  index: number
) => readonly StudioParameterValue[];

/** Initial form values that match the rendered controls. */
export function initialStudioParameterValues(
  command: PipelineRunStudioCommand
): StudioParameterValue[][] {
  return command.parameters.map((parameter) => {
    if (parameter.type === "boolean") return [Boolean(parameter.default)];
    if (parameter.multiple) return parameter.choices ? [] : [""];
    return parameter.default === undefined ? [""] : [parameter.default];
  });
}

/** Convert launch-form values into the bounded wire shape expected by the Studio API. */
export function serializeLaunchValues(
  command: PipelineRunStudioCommand,
  readValues: ReadStudioParameterValues
): PipelineRunStudioLaunchRequest["values"] {
  const values: PipelineRunStudioLaunchRequest["values"] = {};
  command.parameters.forEach((parameter, index) => {
    const parameterValue = readValues(parameter, index);
    if (parameter.type === "boolean") {
      const checked = parameterValue[0];
      if (checked !== Boolean(parameter.default)) values[parameter.key] = checked;
      return;
    }
    if (parameter.multiple) {
      values[parameter.key] =
        parameter.type === "number"
          ? parameterValue.filter((value): value is number => typeof value === "number")
          : parameterValue.filter((value): value is string => typeof value === "string");
      return;
    }
    const single = parameterValue[0];
    if (single !== "" && single !== undefined) values[parameter.key] = single;
  });
  return values;
}

/** Select only execution controls for plan requests. */
export function serializePlanInput(
  command: PipelineRunStudioCommand,
  readValues: ReadStudioParameterValues
): PipelineRunControls {
  const input: Record<string, boolean | readonly string[]> = {};
  command.parameters.forEach((parameter, index) => {
    if (parameter.group !== "execution") return;
    const values = readValues(parameter, index);
    if (parameter.type === "boolean") {
      if (values[0] === true) input[parameter.key] = true;
      return;
    }
    if (parameter.multiple && values.length) {
      input[parameter.key] = values.filter((value): value is string => typeof value === "string");
    }
  });
  // SAFETY: Execution controls are plan selections; the server parser ignores unknown keys.
  return input as PipelineRunControls;
}

const shortId = (id: string) => (id.length > 24 ? id.slice(0, 12) + "…" + id.slice(-7) : id);

function duration(ms: number | null | undefined): string {
  return ms == null
    ? "—"
    : ms < 1000
      ? Math.max(0, Math.round(ms)) + " ms"
      : ms < 60000
        ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s"
        : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}

function clock(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

function dateTime(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    ms
  );
}

export function isoTime(ms: number): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "";
  return new Date(ms).toISOString();
}

function relativeTime(ms: number, nowMs: number): string {
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

export function Status({ value, outputSource }: { value: string; outputSource?: "override" }) {
  return (
    <span class={`status ${value}`}>
      <i class="status-mark" aria-hidden="true">
        {statusMark(value)}
      </i>
      {value}
      {outputSource === "override" && " (overridden)"}
    </span>
  );
}

function EmptyView({ copy, title }: { copy: string; title: string }) {
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

function NestedDetail({ children, label, secondary, stepIds }: NestedDetailProps) {
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

function commandDescription(command: PipelineRunStudioCommand): string {
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
          <div class="sheet-subtitle">Available in this Studio session</div>
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

function Metrics({ commandCount, snapshot }: { commandCount: number; snapshot: StudioSnapshot }) {
  const terminal = snapshot.completedRunCount + snapshot.failedRunCount;
  const success = terminal ? Math.round((snapshot.completedRunCount / terminal) * 100) : 0;
  const pipelineCount =
    commandCount || new Set(snapshot.definitions.map(({ pipelineId }) => pipelineId)).size;
  const metrics = [
    [
      "Active now",
      snapshot.activeRunCount,
      snapshot.activeRunCount ? "Live execution in progress" : "No work in flight",
    ],
    ["Recorded runs", snapshot.runs.length, "Append-only local history"],
    ["Success rate", success + "%", terminal + " terminal runs"],
    [
      "Pipelines",
      pipelineCount,
      commandCount ? "Available to configure" : "Observed in run history",
    ],
  ];
  return (
    <>
      {metrics.map(([label, value, note]) => (
        <article class="metric" key={label}>
          <div class="metric-label">{label}</div>
          <div class="metric-value">{value}</div>
          <div class="metric-note">{note}</div>
        </article>
      ))}
    </>
  );
}

interface RunRowProps {
  nowMs: number;
  onSelect(id: string): void;
  run: StoredPipelineRun;
  runIndex: StudioRunIndex;
  selectedRunId: string | null;
}

function RunRow({ nowMs, onSelect, run, runIndex, selectedRunId }: RunRowProps) {
  const activeSteps = run.steps.filter((step) => step.status === "running");
  const activeStep = activeSteps[0];
  const nestedCount = runIndex.descendantCount(run.runId);
  return (
    <button
      class={`run-row ${run.status} ${
        runIndex.rootRunId(selectedRunId) === run.runId ? "selected" : ""
      }`}
      data-run-id={run.runId}
      onClick={() => onSelect(run.runId)}
    >
      <div class="run-primary">
        <Status value={run.status} />
        <strong>{run.pipelineId}</strong>
        <time
          class="run-time"
          datetime={isoTime(run.startedAtMs)}
          title={dateTime(run.startedAtMs)}
        >
          {relativeTime(run.startedAtMs, nowMs)}
        </time>
      </div>
      <div class="run-secondary">
        <code>{shortId(run.runId)}</code>
        <i class="dot" />
        {run.correlationId && (
          <>
            <span>correlation {run.correlationId}</span>
            <i class="dot" />
          </>
        )}
        <span>{duration(run.durationMs)}</span>
        <i class="dot" />
        <span>{run.steps.length} steps</span>
        {nestedCount > 0 && (
          <>
            <i class="dot" />
            <span>
              {nestedCount} nested run{nestedCount === 1 ? "" : "s"}
            </span>
          </>
        )}
        {run.dryRun && (
          <>
            <i class="dot" />
            <span>dry run</span>
          </>
        )}
      </div>
      {run.status === "running" && (
        <div class="run-activity">
          <strong>
            {activeSteps.length > 1
              ? `${activeSteps.length} steps running`
              : activeStep?.name || activeStep?.id || "Starting"}
          </strong>
          <span>
            {activeSteps.length > 1
              ? `${activeSteps
                  .slice(0, 3)
                  .map((step) => step.name || step.id)
                  .join(", ")}${activeSteps.length > 3 ? ` +${activeSteps.length - 3} more` : ""}`
              : activeStep?.progress?.message || "Execution in progress"}
          </span>
        </div>
      )}
    </button>
  );
}

function StepStatusIcon({ value }: { value: string }) {
  const label = value.charAt(0).toUpperCase() + value.slice(1);
  const icon =
    value === "completed" ? (
      <svg viewBox="0 0 12 12">
        <path d="m2 6 2.4 2.4L10 3" />
      </svg>
    ) : value === "running" ? (
      <i />
    ) : value === "skipped" ? (
      <svg viewBox="0 0 12 12">
        <path d="m3 3 6 6M9 3 3 9" />
      </svg>
    ) : value === "cancelled" ? (
      <svg viewBox="0 0 12 12">
        <rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
      </svg>
    ) : value === "failed" ? (
      "!"
    ) : (
      "…"
    );
  return (
    <span class={`step-status-icon ${value}`} role="img" aria-label={label} title={label}>
      {icon}
    </span>
  );
}

function StepRow({ step }: { step: StoredPipelineStep }) {
  const progressTotal = step.progress?.total;
  const progressWidth = progressTotal
    ? Math.max(0, Math.min(100, ((step.progress?.completed ?? 0) / progressTotal) * 100))
    : step.status === "completed"
      ? 100
      : 18;
  const nested = step.nestedPipeline;
  const nestedCount = nested ? (nested.stepCount ?? nested.stepIds.length) : 0;
  const nestedCountLabel =
    nested && nested.stepIds.length < nestedCount
      ? nested.stepIds.length + " of " + nestedCount + " declared steps"
      : nestedCount + " declared steps";
  const detailCount = step.progress?.detailCount;
  return (
    <article class={`step ${step.status}`}>
      <StepStatusIcon value={step.status} />
      <div class="step-head">
        <strong>{step.name || step.id}</strong>
        {step.outputSource === "override" && (
          <Status value={step.status} outputSource={step.outputSource} />
        )}
        {step.name && <code>{step.id}</code>}
        <span class="step-duration">{duration(step.durationMs)}</span>
      </div>
      {step.description && <div class="step-description">{step.description}</div>}
      {nested && (
        <NestedDetail
          label={nested.pipelineId}
          secondary={`${nestedCountLabel}${nested.mode === "for-each" ? " per runtime item" : ""}`}
          stepIds={nested.stepIds}
        />
      )}
      {step.remote && <NestedDetail label={step.remote.engine} secondary={step.remote.target} />}
      {step.attempt && (
        <div class="execution">
          <span class="execution-summary" title={step.attempt.attemptId}>
            <b>{step.attempt.outputSource === "override" ? "Override validation" : "Execution"}</b>{" "}
            · {shortId(step.attempt.attemptId)}
            {step.attempt.retries.length > 0 &&
              ` · ${step.attempt.retries.length} retr${
                step.attempt.retries.length === 1 ? "y" : "ies"
              }`}
          </span>
        </div>
      )}
      {step.progress && (
        <>
          <div class="progress">
            <i class={`w${Math.round(progressWidth)}`} />
          </div>
          <div class="progress-copy">
            {step.progress.message ||
              step.progress.completed + (progressTotal ? " / " + progressTotal : "") + " complete"}
          </div>
          {step.progress.details && step.progress.details.length > 0 && (
            <div class="progress-details">
              {step.progress.details.map((detail) => (
                <div class={`progress-detail ${detail.status || "running"}`} key={detail.id}>
                  <b>{detail.id}</b>
                  {detail.label && <span>{detail.label}</span>}
                  {detail.outputSource === "override" && <span>(overridden)</span>}
                </div>
              ))}
              {detailCount && step.progress.details.length < detailCount ? (
                <div class="progress-detail-truncated">
                  Showing {step.progress.details.length} of {detailCount} items
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function stepSummary(run: StoredPipelineRun): string {
  const order = ["running", "failed", "cancelled", "skipped", "completed", "planned"] as const;
  return (
    order
      .map((value) => [value, run.steps.filter((step) => step.status === value).length] as const)
      .filter(([, count]) => count)
      .map(([value, count]) => count + " " + value)
      .join(" · ") || "No steps"
  );
}

interface RunDetailProps {
  canCancel: boolean;
  cancelling: boolean;
  liveRunIds: readonly string[];
  nowMs: number;
  onCancel(id: string): void;
  onSelect(id: string): void;
  run: StoredPipelineRun | null;
  runIndex: StudioRunIndex;
}

function RunDetail({
  canCancel,
  cancelling,
  liveRunIds,
  nowMs,
  onCancel,
  onSelect,
  run,
  runIndex,
}: RunDetailProps) {
  if (!run) {
    return (
      <div class="sheet detail">
        <EmptyView
          title="Select a run"
          copy="Choose a run from the history to inspect its steps, retry telemetry, logs, and errors."
        />
      </div>
    );
  }
  const ancestors = runIndex.ancestorsOf(run.runId);
  const children = runIndex.childrenOf(run.runId);
  return (
    <article class="sheet detail">
      <div class="detail-body">
        {ancestors.length > 0 && (
          <div class="run-parentage">
            {ancestors.map((ancestor) => (
              <span key={ancestor.runId}>
                <button type="button" onClick={() => onSelect(ancestor.runId)}>
                  {ancestor.pipelineId}
                </button>
                <span> / </span>
              </span>
            ))}
            <span>{run.pipelineId}</span>
          </div>
        )}
        <div class="detail-heading">
          <div class="detail-heading-copy">
            <div class="detail-kicker">
              {run.parentRunId ? "Nested run" : "Top-level run"} ·{" "}
              {relativeTime(run.startedAtMs, nowMs)}
            </div>
            <h2>{run.pipelineId}</h2>
            <p class="definition-identity">
              Definition:{" "}
              <code>{run.definitionIdentity?.definitionId ?? "Not recorded (legacy trace)"}</code>
              <br />
              Implementation: {run.definitionIdentity?.implementationVersion ?? "Unknown"}
            </p>
            <div class="run-id">{run.runId}</div>
            {run.correlationId && <div class="run-id">Correlation: {run.correlationId}</div>}
          </div>
          <div class="detail-heading-actions">
            <Status value={run.status} />
            {canCancel &&
              run.status === "running" &&
              !run.parentRunId &&
              liveRunIds.includes(run.runId) && (
                <button
                  class="danger-button"
                  type="button"
                  disabled={cancelling}
                  onClick={() => onCancel(run.runId)}
                >
                  Cancel run
                </button>
              )}
          </div>
        </div>
        <div class="detail-meta">
          <div>
            <label>Started</label>
            <span title={isoTime(run.startedAtMs)}>{dateTime(run.startedAtMs)}</span>
          </div>
          <div>
            <label>Duration</label>
            <span>{duration(run.durationMs)}</span>
          </div>
          <div>
            <label>Steps</label>
            <span>{run.steps.length}</span>
          </div>
          <div>
            <label>Events</label>
            <span>{run.eventCount}</span>
          </div>
        </div>
        {children.length > 0 && (
          <>
            <div class="section-title">
              <span>Nested runs</span>
              <span>
                {children.length} direct · {runIndex.descendantCount(run.runId)} total
              </span>
            </div>
            <div class="nested-runs">
              {children.map((child) => {
                const descendantCount = runIndex.descendantCount(child.runId);
                return (
                  <button
                    class="nested-run"
                    type="button"
                    key={child.runId}
                    onClick={() => onSelect(child.runId)}
                  >
                    <Status value={child.status} />
                    <strong>{child.pipelineId}</strong>
                    <small>
                      {duration(child.durationMs)} · {child.steps.length} steps
                      {descendantCount ? " · " + descendantCount + " nested" : ""}
                    </small>
                  </button>
                );
              })}
            </div>
          </>
        )}
        <div class="section-title">
          <span>Step timeline</span>
          <span>{stepSummary(run)}</span>
        </div>
        {run.steps.length ? (
          <div class="step-list">
            {run.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </div>
        ) : (
          <EmptyView
            title="No planned steps"
            copy="This run ended before a step plan was recorded."
          />
        )}
        {run.error && (
          <>
            <div class="section-title">
              <span>Error</span>
            </div>
            <div class="error-card">
              <div class="error-code">
                {run.error.code} · {run.error.phase}
              </div>
              <div class="error-message">{run.error.message}</div>
            </div>
          </>
        )}
        {run.logs.length > 0 && (
          <>
            <div class="section-title">
              <span>Logs</span>
              <span>{run.logs.length}</span>
            </div>
            <div class="logs">
              {run.logs.map((log) => (
                <div class="log-line" key={log.id}>
                  <time class="log-time">{clock(log.timestampMs)}</time>
                  <span class={`log-level ${log.level}`}>{log.level}</span>
                  <span class="log-message">
                    {log.stepId && (
                      <>
                        <b>{log.stepId}</b> ·{" "}
                      </>
                    )}
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

interface RunsViewProps extends Omit<RunDetailProps, "run"> {
  definitions?: readonly StoredPipelineDefinition[];
  runs?: readonly StoredPipelineRun[];
  roots: readonly StoredPipelineRun[];
  selectedRun: StoredPipelineRun | null;
  selectedRunId: string | null;
  totalRunCount: number;
}

export function RunsView(props: RunsViewProps) {
  const activeRuns = props.roots.filter((run) => props.runIndex.subtreeIsRunning(run.runId));
  const historicalRuns = props.roots.filter((run) => !props.runIndex.subtreeIsRunning(run.runId));
  const list = (label: string, runs: readonly StoredPipelineRun[]) =>
    runs.length ? (
      <>
        <div class="run-group">
          {label} · {runs.length}
        </div>
        {runs.map((run) => (
          <RunRow
            key={run.runId}
            nowMs={props.nowMs}
            onSelect={props.onSelect}
            run={run}
            runIndex={props.runIndex}
            selectedRunId={props.selectedRunId}
          />
        ))}
      </>
    ) : null;
  return (
    <>
      <DefinitionHistory
        definitions={props.definitions ?? []}
        runs={props.runs ?? []}
        onSelect={props.onSelect}
      />
      <div class="content-grid">
        <section class="sheet">
          <div class="sheet-head">
            <div>
              <div class="sheet-title">Pipeline runs</div>
              <div class="sheet-subtitle">Top-level runs · nested work stays with its parent</div>
            </div>
            <span class="sheet-subtitle">
              {props.roots.length} top-level · {props.totalRunCount} total
            </span>
          </div>
          <div class="run-list">
            {props.roots.length ? (
              <>
                {list("Running now", activeRuns)}
                {list("Recent", historicalRuns)}
              </>
            ) : (
              <EmptyView
                title="No recorded runs"
                copy="Choose Pipelines to start a run and create local history."
              />
            )}
          </div>
        </section>
        <RunDetail {...props} run={props.selectedRun} />
      </div>
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message || String(error) : String(error);
}

interface LaunchModalProps {
  api: StudioApi;
  commands: readonly PipelineRunStudioCommand[];
  commandId: string | null;
  onClose(): void;
  onLaunched(runId: string): void;
}

function LaunchModal({ api, commands, commandId, onClose, onLaunched }: LaunchModalProps) {
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

function ClearHistoryModal({ api, onCleared, onClose, snapshot }: ClearHistoryModalProps) {
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

type StudioView = "pipelines" | "runs";
const defaultStudioApi = createStudioApi();

export function connectionPresentation(connected: boolean) {
  return {
    className: `pulse${connected ? "" : " lost"}`,
    label: connected ? "Connected · local" : "Connection lost",
  };
}

export function resolveSelectedRunId(
  selectedRunId: string | null,
  pendingRunId: string | null,
  roots: readonly { runId: string }[],
  runIndex: Pick<StudioRunIndex, "rootRunId" | "runById">
): string | null {
  if (selectedRunId && selectedRunId === pendingRunId && !runIndex.runById(selectedRunId)) {
    return selectedRunId;
  }
  if (!selectedRunId || !roots.some((run) => run.runId === runIndex.rootRunId(selectedRunId))) {
    return roots[0]?.runId ?? null;
  }
  return selectedRunId;
}

function StudioApp({ api = defaultStudioApi }: { api?: StudioApi }) {
  const dataController = useMemo(() => new StudioDataController(api), [api]);
  const [data, setData] = useState(() => dataController.getState());
  const { connected, detail, manualRefreshing, snapshot } = data;
  const [commands, setCommands] = useState<PipelineRunStudioCommand[]>([]);
  const [view, setView] = useState<StudioView>("runs");
  const [query, setQuery] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [canCancel, setCanCancel] = useState(false);
  const [canClearHistory, setCanClearHistory] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [launchCommandId, setLaunchCommandId] = useState<string | null>(null);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [toast, setToast] = useState("");
  const pendingRunId = useRef<string | null>(null);
  const runIndex = useMemo(() => createStudioRunIndex(snapshot?.runs ?? []), [snapshot]);

  useEffect(() => {
    setData(dataController.getState());
    return dataController.subscribe(setData);
  }, [dataController]);

  useEffect(() => () => dataController.dispose(), [dataController]);

  useEffect(() => {
    void api
      .loadCommands()
      .then((loaded) => {
        setCommands(loaded);
        if (loaded.length) setView("pipelines");
      })
      .catch(() => {});
    void api
      .loadCapabilities()
      .then((capabilities) => {
        setCanCancel(capabilities.canCancel);
        setCanClearHistory(capabilities.canClearHistory);
      })
      .catch(() => {});
    dataController.refresh();
    const interval = setInterval(() => dataController.refresh(), 1200);
    return () => clearInterval(interval);
  }, [api, dataController]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timeout);
  }, [toast]);

  const matchedRoots = query ? runIndex.matchingRootIds(query) : null;
  const roots = runIndex.roots
    .filter((run) => !matchedRoots || matchedRoots.has(run.runId))
    .sort(
      (left, right) =>
        Number(runIndex.subtreeIsRunning(right.runId)) -
          Number(runIndex.subtreeIsRunning(left.runId)) || right.startedAtMs - left.startedAtMs
    );

  useEffect(() => {
    const pending = pendingRunId.current;
    const next = resolveSelectedRunId(selectedRunId, pending, roots, runIndex);
    if (pending && runIndex.runById(pending)) pendingRunId.current = null;
    if (next !== selectedRunId) setSelectedRunId(next);
  }, [roots, runIndex, selectedRunId]);

  const selectedSummary = runIndex.runById(selectedRunId);
  const selectedFingerprint = selectedSummary
    ? [selectedSummary.runId, selectedSummary.eventCount, selectedSummary.status].join(":")
    : null;
  useEffect(() => {
    dataController.selectRun(selectedRunId, selectedFingerprint);
  }, [dataController, selectedFingerprint, selectedRunId]);

  const showToast = (message: string) => setToast(message);
  const selectRun = (runId: string) => {
    pendingRunId.current = null;
    setSelectedRunId(runId);
  };
  const cancelRun = async (runId: string) => {
    if (!canCancel || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelRun(runId);
      showToast("Run cancelled · " + shortId(runId));
      dataController.invalidate({ delayMs: 80 });
    } catch (caught) {
      showToast(errorMessage(caught));
    } finally {
      setCancelling(false);
    }
  };
  const filteredCommands = commands.filter(
    (command) =>
      !query ||
      command.name.toLowerCase().includes(query.toLowerCase()) ||
      commandDescription(command).toLowerCase().includes(query.toLowerCase())
  );
  const isPipelines = view === "pipelines";
  const selectedRun = detail?.run.runId === selectedRunId ? detail.run : null;
  const connection = connectionPresentation(connected);

  return (
    <>
      <div class="shell">
        <aside class="rail">
          <div class="brand">
            <div class="mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 4.5h6a3 3 0 0 1 3 3v6" stroke="#f7f8f3" strokeWidth="1.5" />
                <circle cx="3" cy="4.5" r="2" fill="#7396ff" />
                <circle cx="12" cy="13.5" r="2" fill="#63d297" />
              </svg>
            </div>
            <div class="brand-copy">
              <strong>Tubeless</strong>
              <small>Local studio</small>
            </div>
          </div>
          <div class="rail-label">Workspace</div>
          <nav class="nav" aria-label="Studio sections">
            {commands.length > 0 && (
              <button
                class={isPipelines ? "active" : ""}
                type="button"
                title="Pipelines"
                onClick={() => setView("pipelines")}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 5h7M4 10h12M9 15h7" />
                  <circle cx="14.5" cy="5" r="1.5" />
                  <circle cx="5.5" cy="15" r="1.5" />
                </svg>
                <span>Pipelines</span>
                <b class="nav-count">{commands.length}</b>
              </button>
            )}
            <button
              class={isPipelines ? "" : "active"}
              type="button"
              title="Runs"
              onClick={() => setView("runs")}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M10 3v4l2.5 1.5M17 10a7 7 0 1 1-2.05-4.95" />
                <path d="M14.5 2.8v3.5H18" />
              </svg>
              <span>Runs</span>
              <b class="nav-count">{snapshot?.runs.length ?? 0}</b>
            </button>
          </nav>
          <div class="rail-foot">
            <div class="connection">
              <i class={connection.className} />
              <span>{connection.label}</span>
            </div>
            <div class="database">append-only SQLite</div>
          </div>
        </aside>
        <main class="workspace">
          <header class="topbar">
            <div>
              <div class="eyebrow">Execution workspace</div>
              <h1>{isPipelines ? "Pipelines" : "Runs"}</h1>
              <p class="lede">
                {isPipelines
                  ? "Choose a declared workflow to configure and run."
                  : "Live work and durable history in one place."}
              </p>
            </div>
            <div class="toolbar">
              <input
                class="search"
                type="search"
                value={query}
                placeholder={isPipelines ? "Filter pipelines" : "Filter runs or IDs"}
                aria-label="Filter"
                onInput={(event) => setQuery(event.currentTarget.value.trim())}
              />
              {commands.length > 0 && (
                <button
                  class="primary-button"
                  onClick={() => setLaunchCommandId(commands[0]?.id ?? "")}
                >
                  Run pipeline
                </button>
              )}
              {canClearHistory && (
                <button
                  class="danger-button"
                  id="clearHistoryButton"
                  type="button"
                  disabled={!snapshot?.runs.length}
                  title={
                    snapshot?.activeRunCount
                      ? "Clear history, including runs left active by an interrupted process"
                      : "Clear history"
                  }
                  onClick={() => setClearHistoryOpen(true)}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    <path d="M3 4.5h10M6 2.5h4M5 4.5l.5 9h5l.5-9M7 7v4M9 7v4" />
                  </svg>
                  <span>Clear history</span>
                </button>
              )}
              <button
                class={`icon-button${manualRefreshing ? " spinning" : ""}`}
                type="button"
                title="Refresh now"
                aria-label="Refresh now"
                onClick={() => dataController.refresh(true)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M16.5 7A7 7 0 1 0 17 11" />
                  <path d="M16.5 3v4h-4" />
                </svg>
              </button>
            </div>
          </header>
          {snapshot && (
            <>
              <section class="metrics">
                <Metrics commandCount={commands.length} snapshot={snapshot} />
              </section>
              <section>
                {isPipelines ? (
                  <PipelinesView commands={filteredCommands} onConfigure={setLaunchCommandId} />
                ) : (
                  <RunsView
                    definitions={snapshot.definitions}
                    runs={snapshot.runs}
                    canCancel={canCancel}
                    cancelling={cancelling}
                    liveRunIds={snapshot.liveRunIds ?? []}
                    nowMs={Date.now()}
                    onCancel={(id) => void cancelRun(id)}
                    onSelect={selectRun}
                    roots={roots}
                    runIndex={runIndex}
                    selectedRun={selectedRun}
                    selectedRunId={selectedRunId}
                    totalRunCount={snapshot.runs.length}
                  />
                )}
              </section>
            </>
          )}
        </main>
      </div>
      {launchCommandId !== null && (
        <LaunchModal
          api={api}
          commands={commands}
          commandId={launchCommandId}
          onClose={() => setLaunchCommandId(null)}
          onLaunched={(runId) => {
            pendingRunId.current = runId;
            setSelectedRunId(runId);
            setView("runs");
            setQuery("");
            setLaunchCommandId(null);
            showToast("Run accepted · " + shortId(runId));
            dataController.invalidate({ delayMs: 80 });
          }}
        />
      )}
      {clearHistoryOpen && snapshot && (
        <ClearHistoryModal
          api={api}
          snapshot={snapshot}
          onClose={() => setClearHistoryOpen(false)}
          onCleared={(eventCount) => {
            pendingRunId.current = null;
            setSelectedRunId(null);
            setClearHistoryOpen(false);
            showToast("Cleared " + eventCount + " recorded event" + (eventCount === 1 ? "" : "s"));
            dataController.invalidate({ resetHistory: true });
          }}
        />
      )}
      {toast && (
        <div class="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

/** Mount the local Studio browser application. */
export function initStudio(): void {
  const root = document.querySelector("#studio-root");
  if (!(root instanceof HTMLElement)) throw new Error("Missing #studio-root");
  render(<StudioApp />, root);
}
