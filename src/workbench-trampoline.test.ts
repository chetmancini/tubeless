import { describe, expect, it } from "vitest";
import {
  MISSING_BUN_EXIT_CODE,
  relayExitCode,
  runTrampoline,
  type TrampolineIo,
  type TrampolineSpawnResult,
} from "./workbench-trampoline";

type ObservedIo = TrampolineIo & {
  errors: string[];
  kills: Array<[number, string]>;
  relays: Array<[string, readonly string[]]>;
};

function fakeIo(
  probeResult: TrampolineSpawnResult,
  relayResult: TrampolineSpawnResult
): ObservedIo {
  const errors: string[] = [];
  const kills: Array<[number, string]> = [];
  const relays: Array<[string, readonly string[]]> = [];
  const io: ObservedIo = {
    probeBun: () => probeResult,
    relayToBun: (binPath, argv) => {
      relays.push([binPath, argv]);
      return relayResult;
    },
    writeError: (message) => {
      errors.push(message);
    },
    pid: 4242,
    kill: (pid, signal) => {
      kills.push([pid, signal]);
    },
    errors,
    kills,
    relays,
  };
  return io;
}

describe("runTrampoline", () => {
  it("prints install instructions and exits 127 when Bun is missing", () => {
    const io = fakeIo(
      { error: { message: "spawn bun ENOENT", code: "ENOENT" } },
      {
        status: 0,
        signal: null,
      }
    );

    expect(runTrampoline("/bin/tubeless.js", ["inspect", "pipeline.ts"], io)).toBe(
      MISSING_BUN_EXIT_CODE
    );
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain("Install Bun:");
    expect(io.errors[0]).toContain("bunx tubeless --help");
    expect(io.relays).toHaveLength(0);
  });

  it("reports the raw error for probe failures that are not ENOENT", () => {
    const io = fakeIo(
      { error: { message: "spawn bun EACCES", code: "EACCES" } },
      {
        status: 0,
        signal: null,
      }
    );

    expect(runTrampoline("/bin/tubeless.js", [], io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain("tubeless could not launch Bun: spawn bun EACCES");
    expect(io.errors[0]).not.toContain("Install Bun:");
  });

  it("relays through Bun with the bin path and forwarded arguments", () => {
    const io = fakeIo({ status: 0, signal: null }, { status: 3, signal: null });

    expect(runTrampoline("/bin/tubeless.js", ["run", "cmd.ts", "--", "--flag"], io)).toBe(3);
    expect(io.relays).toEqual([["/bin/tubeless.js", ["run", "cmd.ts", "--", "--flag"]]]);
    expect(io.errors).toHaveLength(0);
  });

  it("reports the raw error when the relay itself fails to launch", () => {
    const io = fakeIo(
      { status: 0, signal: null },
      {
        error: { message: "spawn bun EACCES", code: "EACCES" },
      }
    );

    expect(runTrampoline("/bin/tubeless.js", [], io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain("tubeless could not launch Bun: spawn bun EACCES");
  });

  it("forwards a failed relay's exit status", () => {
    const io = fakeIo({ status: 0, signal: null }, { status: 6, signal: null });

    expect(runTrampoline("/bin/tubeless.js", [], io)).toBe(6);
    expect(io.errors).toHaveLength(0);
  });
});

describe("relayExitCode", () => {
  it("re-raises relay signal deaths on the current process", () => {
    const io = fakeIo({ status: 0, signal: null }, { status: null, signal: "SIGINT" });

    expect(relayExitCode({ status: null, signal: "SIGINT" }, io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.kills).toEqual([[4242, "SIGINT"]]);
  });

  it("returns 127 when the relay neither exited nor signalled", () => {
    const io = fakeIo({ status: 0, signal: null }, { status: null, signal: null });

    expect(relayExitCode({ status: null, signal: null }, io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.kills).toHaveLength(0);
  });
});
