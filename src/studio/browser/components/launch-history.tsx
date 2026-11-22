import type { StudioLaunchMetadata } from "../../shared/launch-metadata.js";
import type { PipelineRunStudioCommand } from "../../shared/protocol.js";

export function LaunchHistory({
  launch,
  commands,
  onRunAgain,
}: {
  launch: StudioLaunchMetadata | null;
  commands?: readonly PipelineRunStudioCommand[];
  onRunAgain?(launch: StudioLaunchMetadata): void;
}) {
  if (!launch)
    return <p class="form-empty">Launch attribution and inputs were not recorded for this run.</p>;
  const available = commands?.some((command) => command.id === launch.commandId);
  return (
    <section class="launch-history">
      <div class="section-title">
        <span>Launch</span>
        {onRunAgain && (
          <button
            class="secondary-button"
            type="button"
            disabled={!available}
            onClick={() => onRunAgain(launch)}
          >
            Run again
          </button>
        )}
      </div>
      {onRunAgain && !available && (
        <p>This command is no longer available. Choose a current command to start a new run.</p>
      )}
      <dl class="run-definition-facts">
        <dt>Actor</dt>
        <dd>
          {launch.actor
            ? `${launch.actor.label ?? launch.actor.id} (${launch.actor.kind})`
            : "Not recorded"}
          {launch.actor?.label && launch.actor.label !== launch.actor.id && (
            <code> {launch.actor.id}</code>
          )}
        </dd>
        <dt>Trigger</dt>
        <dd>{launch.trigger}</dd>
        <dt>Command</dt>
        <dd>
          <code>{launch.commandId}</code>
        </dd>
        <dt>Launch ID</dt>
        <dd>
          <code>{launch.launchId}</code>
        </dd>
        {launch.deploymentId && (
          <>
            <dt>Runner</dt>
            <dd>{launch.target === "local" ? "Local Bun" : "Cloudflare"}</dd>
          </>
        )}

        <dt>Deployment</dt>
        <dd>
          <code>{launch.deploymentId ?? "Not recorded"}</code>
        </dd>
        <dt>Definition</dt>
        <dd>
          <code>{launch.definitionId ?? "Not recorded"}</code>
        </dd>
        {launch.inputs.recorded.map((input) => (
          <>
            <dt key={input.key}>{input.key}</dt>
            <dd>
              {input.value === undefined ? (
                "Not supplied"
              ) : (
                <code>{JSON.stringify(input.value)}</code>
              )}
            </dd>
          </>
        ))}
      </dl>
      <p class="field-hint">
        {launch.inputs.omitted.length
          ? `Input values not recorded: ${launch.inputs.omitted.join(", ")}.`
          : "All declared inputs were permitted in history."}{" "}
        Run again opens a form for review using the current command.
      </p>
    </section>
  );
}
