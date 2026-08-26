import { describe, expect, it } from "vitest";
import {
  normalizeMultiSelectChoices,
  parseMultiSelectInput,
  type MultiSelectChoice,
} from "./prompt-select";

const choices: MultiSelectChoice[] = [
  { value: "alpha", label: "Alpha item" },
  { value: "beta", label: "Beta item" },
  { value: "gamma", label: "Gamma item" },
];

describe("normalizeMultiSelectChoices", () => {
  it("accepts bare strings and object choices", () => {
    expect(normalizeMultiSelectChoices(["a", { value: "b", label: "Bee" }])).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "Bee" },
    ]);
  });
});

describe("parseMultiSelectInput", () => {
  it("parses all and * when allowAll is set", () => {
    expect(parseMultiSelectInput("all", choices, { allowAll: true })).toEqual({ kind: "all" });
    expect(parseMultiSelectInput(" * ", choices, { allowAll: true })).toEqual({ kind: "all" });
  });

  it("does not treat all as special without allowAll", () => {
    expect(parseMultiSelectInput("all", choices, { allowAll: false })).toBeNull();
  });

  it("parses 1-based indices in choice order", () => {
    expect(parseMultiSelectInput("1 3", choices)).toEqual({
      kind: "values",
      values: ["alpha", "gamma"],
    });
  });

  it("parses values case-insensitively and preserves choice order", () => {
    expect(parseMultiSelectInput("gamma,ALPHA,gamma", choices)).toEqual({
      kind: "values",
      values: ["alpha", "gamma"],
    });
  });

  it("supports a custom all token", () => {
    expect(
      parseMultiSelectInput("everything", choices, { allowAll: true, allValue: "everything" })
    ).toEqual({ kind: "all" });
  });

  it("returns null for empty or unknown tokens", () => {
    expect(parseMultiSelectInput("", choices)).toBeNull();
    expect(parseMultiSelectInput("99", choices)).toBeNull();
    expect(parseMultiSelectInput("not-a-choice", choices)).toBeNull();
  });
});
