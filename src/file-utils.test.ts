import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson, resetDir, writeJson } from "./file-utils";

describe("readJson", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-json-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses a JSON file's contents", () => {
    const filePath = path.join(dir, "data.json");
    fs.writeFileSync(filePath, JSON.stringify({ count: 3, names: ["a", "b"] }));

    expect(readJson<{ count: number; names: string[] }>(filePath)).toEqual({
      count: 3,
      names: ["a", "b"],
    });
  });

  it("throws if the file does not exist", () => {
    expect(() => readJson(path.join(dir, "missing.json"))).toThrow();
  });

  it("throws if the file is not valid JSON", () => {
    const filePath = path.join(dir, "invalid.json");
    fs.writeFileSync(filePath, "{ not json");

    expect(() => readJson(filePath)).toThrow();
  });
});

describe("writeJson", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-json-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates missing parent directories and writes pretty-printed JSON with a trailing newline", () => {
    const filePath = path.join(dir, "nested", "data.json");

    writeJson(filePath, { count: 3, names: ["a", "b"] });

    expect(fs.readFileSync(filePath, "utf-8")).toBe(
      `${JSON.stringify({ count: 3, names: ["a", "b"] }, null, 2)}\n`
    );
  });

  it("round-trips through readJson", () => {
    const filePath = path.join(dir, "data.json");
    const value = { count: 3, names: ["a", "b"] };

    writeJson(filePath, value);

    expect(readJson(filePath)).toEqual(value);
  });

  it("overwrites an existing file", () => {
    const filePath = path.join(dir, "data.json");
    writeJson(filePath, { count: 1 });
    writeJson(filePath, { count: 2 });

    expect(readJson(filePath)).toEqual({ count: 2 });
  });

  it("does not leave a .tmp sibling after a successful write", () => {
    const filePath = path.join(dir, "data.json");
    writeJson(filePath, { ok: true });
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("resetDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-dir-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory when it does not exist yet", () => {
    const target = path.join(dir, "fresh");

    resetDir(target);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("removes existing contents before recreating the directory", () => {
    const target = path.join(dir, "existing");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "stale.txt"), "old");

    resetDir(target);

    expect(fs.readdirSync(target)).toEqual([]);
  });
});
