import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DUPLICATE_SIGNAL_WINDOW_MS, onFirstProcessSignal } from "./workbench-shared.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli } from "./workbench.js";
import {
  captureIo,
  writeActualPipelineCommandModule,
  writeActualPipelineModule,
} from "./workbench.test-support.js";

describe("workbench CLI lifecycle", () => {
  it("uses stable validation, planning, execution, and cancellation exit codes", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const validationIo = captureIo(directory);
    const planningIo = captureIo(directory);
    const executionIo = captureIo(directory);
    const cancellationIo = captureIo(directory);

    const validationExit = await runWorkbenchCli(["run", "pipeline.mjs"], validationIo);
    const planningExit = await runWorkbenchCli(
      ["plan", "pipeline.mjs", "--target", "work", "--target", "work"],
      planningIo
    );
    const executionExit = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "failure"],
      executionIo
    );
    const cancellationExit = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "cancel"],
      cancellationIo
    );

    expect(validationExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.validation);
    expect(validationIo.errors.join("")).toContain("Missing required option --message");
    expect(planningExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.planning);
    expect(planningIo.output.join("")).toContain("TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE");
    expect(executionExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(executionIo.errors.join("")).toContain("TUBELESS_STEP_FAILED");
    expect(executionIo.errors.join("")).toContain("intentional command failure");
    expect(cancellationExit).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
    expect(cancellationIo.errors.join("")).toContain("TUBELESS_RUN_CANCELLED");
  });

  it("prints command help only through the application-argument boundary", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const workbenchHelpIo = captureIo(directory);
    const commandHelpIo = captureIo(directory);

    expect(await runWorkbenchCli(["run", "--help"], workbenchHelpIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runWorkbenchCli(["run", "pipeline.mjs", "--", "--help"], commandHelpIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(workbenchHelpIo.output.join("")).toContain("Pass application flags after --");
    expect(workbenchHelpIo.output.join("")).not.toContain("--message");
    expect(commandHelpIo.output.join("")).toContain("--message <string>");
  });

  it("rejects raw pipelines and application flags outside the command boundary", async () => {
    const pipelineFixture = await writeActualPipelineModule();
    const rawPipelineIo = captureIo(pipelineFixture.directory);
    const misplacedFlagFixture = await writeActualPipelineCommandModule();
    const misplacedFlagIo = captureIo(misplacedFlagFixture.directory);

    expect(await runWorkbenchCli(["run", "pipeline.mjs"], rawPipelineIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(rawPipelineIo.errors.join("")).toContain("does not export a tubeless pipeline command");
    expect(
      await runWorkbenchCli(
        ["run", "pipeline.mjs", "--message", "outside-boundary"],
        misplacedFlagIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(misplacedFlagIo.errors.join("")).toContain("Application flags belong after --");
  });

  it("turns SIGINT into cancellation and removes its temporary listener", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onSpy = vi.spyOn(process, "on");
    const removeListenerSpy = vi.spyOn(process, "removeListener");

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "wait"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)();

      expect(await runPromise).toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
      expect(io.errors.join("")).toContain("SIGINT received; cancelling pipeline work.");
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", registration?.[1]]);
    } finally {
      onSpy.mockRestore();
      removeListenerSpy.mockRestore();
    }
  });

  it("preserves a structured execution failure that races with SIGINT", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onSpy = vi.spyOn(process, "on");

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "fail-after-abort"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)();
      // The forwarded duplicate (trampoline + direct terminal delivery)
      // lands inside the swallow window and must not re-trigger anything.
      (registration![1] as () => void)();

      expect(await runPromise).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
      expect(io.errors.join("")).toContain("TUBELESS_STEP_FAILED");
      expect(io.errors.join("")).toContain("intentional failure after abort");
      expect(io.errors.join("").match(/SIGINT received/g)).toHaveLength(1);
    } finally {
      onSpy.mockRestore();
    }
  });

  it("re-raises a SIGINT after the duplicate window as a force-quit", async () => {
    const { directory, filePath } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const onSpy = vi.spyOn(process, "on");
    const removeListenerSpy = vi.spyOn(process, "removeListener");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const runPromise = runWorkbenchCli(
        ["run", "pipeline.mjs", "--", "--message", "hello", "--mode", "wait"],
        io
      );
      const fixture = (await import(pathToFileURL(filePath).href)) as { started: Promise<void> };
      await fixture.started;
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)();

      // Past the swallow window, a second SIGINT is a deliberate force-quit:
      // the listener removes itself and re-raises SIGINT on this process so
      // default termination takes over.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + DUPLICATE_SIGNAL_WINDOW_MS + 1000);
      (registration![1] as () => void)();

      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", registration?.[1]]);
      expect(io.errors.join("").match(/SIGINT received/g)).toHaveLength(1);

      // The mocked kill means the run never actually dies; await it so the
      // finally in runCommand still cleans up.
      await runPromise;
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
      onSpy.mockRestore();
      removeListenerSpy.mockRestore();
    }
  });

  it("swallows a duplicate queued behind a blocking first dispatch", async () => {
    const events: string[] = [];
    const onSpy = vi.spyOn(process, "on");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const dispose = onFirstProcessSignal(["SIGINT"], () => {
        events.push("first");
        // Simulate >300ms of synchronous cleanup work inside the abort
        // dispatch: the trampoline's duplicate waits behind this call.
        const start = Date.now();
        while (Date.now() - start < 400) {
          // busy-wait
        }
      });
      const registration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      expect(registration).toBeDefined();
      (registration![1] as () => void)(); // first: window arms after return
      (registration![1] as () => void)(); // queued duplicate: swallowed

      expect(events).toEqual(["first"]);
      expect(killSpy).not.toHaveBeenCalled();
      dispose();
    } finally {
      killSpy.mockRestore();
      onSpy.mockRestore();
    }
  });

  it("keeps per-signal windows independent across SIGINT and SIGTERM", async () => {
    const events: string[] = [];
    const onSpy = vi.spyOn(process, "on");
    const removeListenerSpy = vi.spyOn(process, "removeListener");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const dispose = onFirstProcessSignal(["SIGINT", "SIGTERM"], (signal) => {
        events.push(signal);
      });
      const sigintRegistration = onSpy.mock.calls.find(([event]) => event === "SIGINT");
      const sigtermRegistration = onSpy.mock.calls.find(([event]) => event === "SIGTERM");
      expect(sigintRegistration).toBeDefined();
      expect(sigtermRegistration).toBeDefined();

      // A SIGINT arms only its own window: a first SIGTERM still gets its
      // graceful first delivery rather than being silenced or force-quit.
      (sigintRegistration![1] as () => void)();
      (sigtermRegistration![1] as () => void)();
      expect(events).toEqual(["SIGINT", "SIGTERM"]);

      // A post-window second press removes ALL listeners and re-raises:
      // neither signal can fire onFirst again mid-teardown.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + DUPLICATE_SIGNAL_WINDOW_MS + 1000);
      (sigintRegistration![1] as () => void)();
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGINT", sigintRegistration?.[1]]);
      expect(removeListenerSpy.mock.calls).toContainEqual(["SIGTERM", sigtermRegistration?.[1]]);
      expect(events).toEqual(["SIGINT", "SIGTERM"]);

      dispose();
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
      removeListenerSpy.mockRestore();
      onSpy.mockRestore();
    }
  });
});
