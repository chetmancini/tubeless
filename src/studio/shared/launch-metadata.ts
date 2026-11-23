import {
  wireArray,
  wireBoolean,
  wireEnum,
  wireNumber,
  wireObject,
  wireOptional,
  wireRefine,
  wireString,
  wireUnion,
  type InferWireSchema,
  type WireSchema,
} from "../../tracing/wire-schema.js";

const text = wireString({ maxLength: 1024 });
const key = wireString({ maxLength: 4096 });
const scalarText = wireString({ allowEmpty: true, maxLength: 4096 });
const inputValue = wireUnion([
  wireBoolean(),
  wireNumber(),
  scalarText,
  wireArray(wireNumber(), { maxItems: 128 }),
  wireArray(scalarText, { maxItems: 128 }),
]);

/** User or service identity verified by the host or supplied by trusted application code. */
export interface LaunchActor {
  readonly id: string;
  readonly kind: "user" | "service";
  readonly label?: string;
}

const launchActorSchema: WireSchema<LaunchActor> = wireObject({
  id: text,
  kind: wireEnum(["user", "service"]),
  label: wireOptional(text),
});
export const launchTriggerSchema = wireEnum(["manual", "schedule", "queue", "code"]);
export const launchAttributionSchema = wireObject({
  actor: wireOptional(launchActorSchema),
  trigger: wireOptional(launchTriggerSchema),
});
/** Origin of a deliberate launch submission. */
export type LaunchTrigger = InferWireSchema<typeof launchTriggerSchema>;
export type LaunchAttribution = InferWireSchema<typeof launchAttributionSchema>;

/** Trusted browser request context; browser launches always have the manual trigger. */
export interface StudioLaunchContext {
  readonly actor?: LaunchActor;
  readonly idempotencyKey?: string;
}

const savedLaunchInputSchema = wireRefine(
  wireObject({
    key,
    type: wireEnum(["boolean", "number", "string", "path"]),
    multiple: wireBoolean(),
    value: wireOptional(inputValue),
  }),
  (input, path) => {
    if (input.value === undefined) return;
    const expected = input.type === "path" ? "string" : input.type;
    if (
      input.multiple
        ? !Array.isArray(input.value) || !input.value.every((value) => typeof value === expected)
        : typeof input.value !== expected
    )
      throw new Error(`${path}: saved input does not match its parameter shape`);
  }
);
export const studioLaunchMetadataSchema = wireObject({
  launchId: text,
  commandId: wireString(),
  deploymentId: wireOptional(text),
  target: wireOptional(wireEnum(["local"])),
  recoveryRunIds: wireOptional(wireArray(wireString(), { maxItems: 64 })),
  definitionId: wireOptional(text),
  actor: wireOptional(launchActorSchema),
  trigger: launchTriggerSchema,
  inputs: wireObject({
    recorded: wireArray(savedLaunchInputSchema, { maxItems: 128 }),
    omitted: wireArray(key, { maxItems: 128 }),
  }),
});
export type StudioLaunchMetadata = InferWireSchema<typeof studioLaunchMetadataSchema>;

export type LaunchInputPolicy = Readonly<Record<string, readonly string[]>>;
