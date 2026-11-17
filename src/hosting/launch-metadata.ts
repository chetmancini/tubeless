import type { HostedCommand } from "./hosting-commands.js";
import {
  studioLaunchMetadataSchema,
  type LaunchInputPolicy,
  type LaunchAttribution,
  type StudioLaunchMetadata,
} from "../studio/shared/launch-metadata.js";
import type { HostedLaunchValues } from "./launch-admission.js";

/** Snapshot and validate an explicit per-command allowlist; never infer safe fields. */
export function launchInputPolicy(
  commands: ReadonlyMap<string, HostedCommand>,
  policy: LaunchInputPolicy = {}
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    Object.entries(policy).map(([commandId, keys]) => {
      const command = commands.get(commandId);
      if (!command) throw new Error(`Unknown input-history command ${JSON.stringify(commandId)}.`);
      const parameters = new Set(command.descriptor.parameters.map((parameter) => parameter.key));
      for (const key of keys) {
        if (!parameters.has(key))
          throw new Error(
            `Unknown input-history parameter ${JSON.stringify(key)} for command ${JSON.stringify(commandId)}.`
          );
      }
      return [commandId, new Set(keys)];
    })
  );
}

/** Build only the launch data the operator explicitly allowed to persist. */
export function recordedLaunch(
  command: HostedCommand,
  values: HostedLaunchValues,
  allowed: ReadonlySet<string> | undefined,
  identity: { launchId: string; deploymentId: string | undefined },
  context: LaunchAttribution
): StudioLaunchMetadata {
  return studioLaunchMetadataSchema.decode(
    {
      ...identity,
      commandId: command.descriptor.id,
      definitionId: command.descriptor.definitionId,
      actor: context.actor,
      trigger: context.trigger ?? "code",
      inputs: {
        recorded: command.descriptor.parameters
          .filter((parameter) => allowed?.has(parameter.key))
          .map((parameter) => ({
            key: parameter.key,
            type: parameter.type,
            multiple: parameter.multiple,
            value: values[parameter.key],
          })),
        omitted: command.descriptor.parameters
          .filter((parameter) => !allowed?.has(parameter.key))
          .map((parameter) => parameter.key),
      },
    },
    "Launch metadata"
  );
}
