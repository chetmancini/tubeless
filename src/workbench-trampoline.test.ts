import { describe, expect, it } from "vitest";
import {
  FORWARDED_SIGNALS,
  MISSING_BUN_EXIT_CODE,
  relayExitCode,
  runTrampoline,
  type TrampolineIo,
  type TrampolineProbeResult,
  type TrampolineRelayOutcome,
} from "./workbench-trampoline";

type RelayHandle = ReturnType<TrampolineIo["startRelay"]>;

interface ObservedIo extends TrampolineIo {
  errors: string[];
  kills: Array<[number, string]>;
  forwarded: NodeJS.Signals[];
  signalHandlers: Array<(signal: NodeJS.Signals) => void>;
  relays: Array<[string, readonly string[]]>;
  events: string[];
}

interface FakeRelayConfig {
  probeResult: TrampolineProbeResult;
  relayOutcome: TrampolineRelayOutcome;
}

function fakeIo(config: FakeRelayConfig): ObservedIo {
  const errors: string[] = [];
  const kills: Array<[number, string]> = [];
  const forwarded: NodeJS.Signals[] = [];
  const signalHandlers: Array<(signal: NodeJS.Signals) => void> = [];
  const relays: Array<[string, readonly string[]]> = [];
  const events: string[] = [];
  let disposed = false;
  const io: ObservedIo = {
    probeBun: () => config.probeResult,
    startRelay: (binPath, argv) => {
      relays.push([binPath, argv]);
      return {
        outcome: Promise.resolve(config.relayOutcome),
        sendSignal: (signal) => {
          forwarded.push(signal);
        },
      };
    },
    pid: 4242,
    writeError: (message) => {
      errors.push(message);
    },
    kill: (pid, signal) => {
      events.push(`kill:${signal}`);
      kills.push([pid, signal]);
    },
    onSignal: (_signals, handler) => {
      signalHandlers.push(handler);
      return () => {
        if (!disposed) {
          disposed = true;
          events.push("dispose");
        }
      };
    },
    errors,
    kills,
    forwarded,
    signalHandlers,
    relays,
    events,
  };
  return io;
}

describe("runTrampoline", () => {
  it("prints install instructions and exits 127 when Bun is missing", async () => {
    const io = fakeIo({
      probeResult: { error: { message: "spawn bun ENOENT", code: "ENOENT" } },
      relayOutcome: { status: 0, signal: null },
    });

    expect(await runTrampoline("/bin/tubeless.js", ["inspect", "pipeline.ts"], io)).toBe(
      MISSING_BUN_EXIT_CODE
    );
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain("Install Bun:");
    expect(io.errors[0]).toContain("bunx tubeless --help");
    expect(io.relays).toHaveLength(0);
  });

  it("reports the raw error for probe failures that are not ENOENT", async () => {
    const io = fakeIo({
      probeResult: { error: { message: "spawn bun EACCES", code: "EACCES" } },
      relayOutcome: { status: 0, signal: null },
    });

    expect(await runTrampoline("/bin/tubeless.js", [], io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain("tubeless could not launch Bun: spawn bun EACCES");
    expect(io.errors[0]).not.toContain("Install Bun:");
  });

  it("relays through Bun with the bin path and forwarded arguments", async () => {
    const io = fakeIo({
      probeResult: { status: 0 },
      relayOutcome: { status: 3, signal: null },
    });

    expect(await runTrampoline("/bin/tubeless.js", ["run", "cmd.ts", "--", "--flag"], io)).toBe(3);
    expect(io.relays).toEqual([["/bin/tubeless.js", ["run", "cmd.ts", "--", "--flag"]]]);
    expect(io.errors).toHaveLength(0);
  });

  it("reports the raw error when the relay itself fails to launch", async () => {
    const io = fakeIo({
      probeResult: { status: 0 },
      relayOutcome: { error: { message: "spawn bun EACCES", code: "EACCES" }, status: null },
    });

    expect(await runTrampoline("/bin/tubeless.js", [], io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain("tubeless could not launch Bun: spawn bun EACCES");
  });

  it("forwards a failed relay's exit status", async () => {
    const io = fakeIo({ probeResult: { status: 0 }, relayOutcome: { status: 6, signal: null } });

    expect(await runTrampoline("/bin/tubeless.js", [], io)).toBe(6);
    expect(io.errors).toHaveLength(0);
  });

  it("registers forwarding for supervisor signals and relays them to the Bun child", async () => {
    const io = fakeIo({ probeResult: { status: 0 }, relayOutcome: { status: 0, signal: null } });

    await runTrampoline("/bin/tubeless.js", [], io);
    expect(io.signalHandlers).toHaveLength(1);
    io.signalHandlers[0]("SIGTERM");
    io.signalHandlers[0]("SIGINT");
    expect(io.forwarded).toEqual(["SIGTERM", "SIGINT"]);
  });

  it("forwards every declared supervisor signal", () => {
    expect([...FORWARDED_SIGNALS]).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  it("disposes signal forwarding before re-raising the relay's signal", async () => {
    const io = fakeIo({
      probeResult: { status: 0 },
      relayOutcome: { status: null, signal: "SIGTERM" },
    });

    expect(await runTrampoline("/bin/tubeless.js", [], io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.events).toEqual(["dispose", "kill:SIGTERM"]);
  });
});

describe("relayExitCode", () => {
  it("re-raises relay signal deaths on the current process", async () => {
    const io = fakeIo({ probeResult: { status: 0 }, relayOutcome: { status: 0, signal: null } });

    expect(relayExitCode({ status: null, signal: "SIGINT" }, io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.kills).toEqual([[4242, "SIGINT"]]);
  });

  it("returns 127 when the relay neither exited nor signalled", async () => {
    const io = fakeIo({ probeResult: { status: 0 }, relayOutcome: { status: 0, signal: null } });

    expect(relayExitCode({ status: null, signal: null }, io)).toBe(MISSING_BUN_EXIT_CODE);
    expect(io.kills).toHaveLength(0);
  });
});

// Unused-type check: RelayHandle documents the trampoline's startRelay contract
// for future spy-based tests; referenced here to keep it exported-accurate.
type KeptRelayHandle = RelayHandle;
void {} satisfies Record<string, never> as { handle?: KeptRelayHandle };
