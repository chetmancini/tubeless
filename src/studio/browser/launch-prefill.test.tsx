import { describe, expect, it, vi } from "vitest";
import { renderToString } from "preact-render-to-string";
import type { PipelineRunStudioCommand } from "../shared/protocol.js";
import type { StudioLaunchMetadata } from "../shared/launch-metadata.js";
import type { CliParameterDescriptor } from "../../cli/cli.js";
import { createStudioLaunchForm, serializeLaunchValues } from "./launch-form.js";
import { LaunchHistory } from "./components/launch-history.js";
import { CommandFields, LaunchModal } from "./components/launch.js";
import { createStudioApi } from "./transport.js";
import { defineCommand } from "../../cli/cli.js";

const parameter = (
  key: string,
  overrides: Partial<CliParameterDescriptor> = {}
): CliParameterDescriptor => ({
  key,
  flag: `--${key}`,
  type: "string",
  multiple: false,
  positional: false,
  required: false,
  ...overrides,
});
const command: PipelineRunStudioCommand = {
  id: "demo",
  name: "Demo",
  canPlan: true,
  definitionId: "new",
  parameters: [
    parameter("name"),
    parameter("secret", { required: true }),
    parameter("empty"),
    parameter("count", { type: "number", integer: true, min: 1 }),
    parameter("choice", { choices: ["current"] }),
    parameter("list", { multiple: true }),
    parameter("changed", { type: "number" }),
  ],
};
const launch: StudioLaunchMetadata = {
  launchId: "original",
  commandId: "demo",
  definitionId: "old",
  actor: { id: "user", kind: "user", label: "<script>" },
  trigger: "manual",
  inputs: {
    recorded: [
      { key: "name", type: "string", multiple: false, value: "Ada" },
      { key: "empty", type: "string", multiple: false, value: "" },
      { key: "count", type: "number", multiple: false, value: 0 },
      { key: "choice", type: "string", multiple: false, value: "removed" },
      { key: "list", type: "string", multiple: true, value: ["one", "two"] },
      { key: "changed", type: "string", multiple: false, value: "old" },
      { key: "removed", type: "string", multiple: false, value: "unused" },
      { key: "absent", type: "string", multiple: false },
    ],
    omitted: ["secret"],
  },
};

describe("Studio rerun review", () => {
  it.each([false, true])(
    "preserves a restored %s boolean against an opposite environment fallback",
    (saved) => {
      const cli = defineCommand({
        name: "Boolean fixture",
        params: { enabled: { type: "boolean", default: saved, env: "ENABLED" } },
        run: (values) => values.enabled,
      });
      const current = { ...command, parameters: cli.descriptor.parameters };
      const previous: StudioLaunchMetadata = {
        ...launch,
        inputs: {
          recorded: [{ key: "enabled", type: "boolean", multiple: false, value: saved }],
          omitted: [],
        },
      };
      const context = { env: { ENABLED: String(!saved) } };
      expect(cli.parseValues({}, context)).toMatchObject({
        kind: "values",
        values: { enabled: !saved },
      });
      const form = createStudioLaunchForm(current, previous);
      const enabledIndex = current.parameters.findIndex((parameter) => parameter.key === "enabled");
      expect(form.values[enabledIndex]).toEqual([saved]);
      const submitted = serializeLaunchValues(current, form);
      expect(submitted).toEqual({ enabled: saved });
      expect(cli.parseValues(submitted, context)).toMatchObject({
        kind: "values",
        values: { enabled: saved },
      });
      const unrecorded = { ...previous, inputs: { recorded: [], omitted: ["enabled"] } };
      expect(serializeLaunchValues(current, createStudioLaunchForm(current, unrecorded))).toEqual(
        {}
      );
    }
  );
  it("shows current scalar defaults and environment fallbacks for unsaved rerun fields", () => {
    const current = {
      ...command,
      parameters: [
        parameter("limit", { type: "number", default: 100 }),
        parameter("source", { default: "current.csv", environment: "IMPORT_SOURCE" }),
      ],
    };
    const form = createStudioLaunchForm(current, launch);
    expect(serializeLaunchValues(current, form)).toEqual({});
    const html = renderToString(
      <CommandFields command={current} form={form} onChange={() => {}} />
    );
    expect(html).toMatch(/class="field-hint"[^>]*>[^<]*100/);
    expect(html).toMatch(/class="field-hint"[^>]*>[^<]*IMPORT_SOURCE[^<]*current\.csv/);
  });

  it("allows a recorded empty required string while still requiring an unsaved value", () => {
    const current = {
      ...command,
      parameters: [
        parameter("empty", { required: true, default: "fallback" }),
        parameter("missing", { required: true }),
      ],
    };
    const form = createStudioLaunchForm(current, launch);
    const html = renderToString(
      <CommandFields command={current} form={form} onChange={() => {}} />
    );
    const empty = html.match(/<input[^>]*id="run-param-0"[^>]*>/)?.[0];
    const missing = html.match(/<input[^>]*id="run-param-1"[^>]*>/)?.[0];
    expect(empty).toBeDefined();
    expect(empty).not.toMatch(/\srequired(?:[\s=/>])/);
    expect(missing).toMatch(/\srequired(?:[\s=/>])/);
    expect(serializeLaunchValues(current, form)).toEqual({ empty: "" });
    const unsaved = createStudioLaunchForm(current, {
      ...launch,
      inputs: { recorded: [], omitted: ["empty", "missing"] },
    });
    const unsavedHtml = renderToString(
      <CommandFields command={current} form={unsaved} onChange={() => {}} />
    );
    expect(unsavedHtml.match(/<input[^>]*id="run-param-0"[^>]*>/)?.[0]).toMatch(
      /\srequired(?:[\s=/>])/
    );
  });
  it("uses current boolean defaults while leaving unsaved scalar inputs blank", () => {
    const current = {
      ...command,
      parameters: [
        parameter("enabled", { type: "boolean", default: true }),
        parameter("unsaved", { default: "current-default" }),
        parameter("empty", { default: "fallback" }),
      ],
    };
    const form = createStudioLaunchForm(current, launch);
    expect(form.values).toEqual([[true], [""], [""]]);
    expect(serializeLaunchValues(current, form)).toEqual({ empty: "" });
    expect(
      serializeLaunchValues(
        current,
        createStudioLaunchForm(current, { ...launch, commandId: "other" })
      )
    ).toEqual({ unsaved: "current-default", empty: "fallback" });
    const changed = { ...current, parameters: [parameter("empty", { choices: ["allowed"] })] };
    expect(serializeLaunchValues(changed, createStudioLaunchForm(changed, launch))).toEqual({});
  });
  it("clears repeatable strings the line-based control cannot represent without changing them", () => {
    for (const value of [["line\nbreak"], [" padded "], [""]]) {
      const previous = {
        ...launch,
        inputs: {
          recorded: [{ key: "list", type: "string" as const, multiple: true, value }],
          omitted: [],
        },
      };
      expect(createStudioLaunchForm(command, previous).review!.skipped).toContain("list");
    }
    expect(
      createStudioLaunchForm(
        { ...command, definitionId: undefined },
        { ...launch, definitionId: undefined }
      ).review!.definitionChanged
    ).toBe(true);
  });
  it("keeps omitted selection controls empty instead of submitting an empty choice", () => {
    const current = {
      ...command,
      parameters: [
        parameter("stepIds", { multiple: true, choices: ["load"] }),
        parameter("targets", { multiple: true, choices: ["load"] }),
      ],
    };
    const prefill = createStudioLaunchForm(current, launch);
    expect(prefill.values).toEqual([[], []]);
    expect(serializeLaunchValues(current, prefill)).toEqual({
      stepIds: [],
      targets: [],
    });
  });
  it("prefills only compatible saved inputs and leaves missing required values blank", () => {
    const prefill = createStudioLaunchForm(command, launch);
    expect(prefill.values).toEqual([["Ada"], [""], [""], [""], [""], ["one\ntwo"], [""]]);
    expect(prefill.review!.skipped).toEqual(["count", "choice", "changed", "removed", "absent"]);
    expect(prefill.review!.definitionChanged).toBe(true);
    expect(
      serializeLaunchValues(
        { ...command, parameters: [parameter("empty", { default: "fallback" })] },
        createStudioLaunchForm(
          { ...command, parameters: [parameter("empty", { default: "fallback" })] },
          launch
        )
      )
    ).toEqual({ empty: "" });
  });

  it("escapes metadata and explains omitted, absent and empty values and removed commands", () => {
    const html = renderToString(
      <LaunchHistory launch={launch} commands={[]} onRunAgain={() => {}} />
    );
    expect(html).toContain("&lt;script");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Not supplied");
    expect(html).toContain("&quot;&quot;");
    expect(html).toContain("secret");
    expect(html).toContain("disabled");
    expect(renderToString(<LaunchHistory launch={null} />)).toContain("not recorded");
  });

  it("opens review without launching, and every deliberate submission gets a fresh key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ accepted: true, runId: "new-run" }));
    const api = createStudioApi(fetcher);
    renderToString(
      <LaunchModal
        api={api}
        commandId="demo"
        commands={[command]}
        previousLaunch={launch}
        onClose={() => {}}
        onLaunched={() => {}}
      />
    );
    expect(fetcher).not.toHaveBeenCalled();
    await api.launch("demo", { name: "Ada" });
    await api.launch("demo", { name: "Ada" });
    const bodies = fetcher.mock.calls.map(
      ([, init]) => JSON.parse(String(init!.body)) as { idempotencyKey: string }
    );
    expect(bodies[0]!.idempotencyKey).toBeTruthy();
    expect(bodies[1]!.idempotencyKey).not.toBe(bodies[0]!.idempotencyKey);
    expect(bodies.map((body) => body.idempotencyKey)).not.toContain("original");
  });
});
