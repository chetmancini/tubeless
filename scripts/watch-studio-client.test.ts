import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStudioClientWatch } from "./watch-studio-client.mjs";

const watchMock = vi.hoisted(() => ({
  close: vi.fn(),
  on: vi.fn(),
  watch:
    vi.fn<
      (
        path: string,
        options: unknown,
        listener: (event: string, filename: string | null) => void
      ) => unknown
    >(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: watchMock.watch,
}));

function changeSource(filename: string) {
  const listener = watchMock.watch.mock.calls[0]?.[2];
  if (!listener) throw new Error("Source watcher was not opened.");
  listener("change", filename);
}

describe("startStudioClientWatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    watchMock.watch.mockReturnValue({ close: watchMock.close, on: watchMock.on });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces all source changes, queues an active rebuild, and stops on close", async () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-studio-watch-"));
    mkdirSync(join(root, "src/studio/browser"), { recursive: true });
    mkdirSync(join(root, "src/cli"), { recursive: true });
    mkdirSync(join(root, "dist/studio/browser"), { recursive: true });
    mkdirSync(join(root, "dist/cloudflare"), { recursive: true });
    writeFileSync(join(root, "src/studio/browser/leaf.ts"), 'export const label = "Studio";\n');
    writeFileSync(join(root, "src/studio/browser/entry.ts"), 'export const text = "Studio";\n');
    writeFileSync(join(root, "src/cli/cli-parser.ts"), "export const n = 1;\n");
    writeFileSync(join(root, "dist/studio/browser/entry.js"), "ok\n");
    writeFileSync(join(root, "dist/cloudflare/cloudflare-studio-client.js"), "ok\n");
    writeFileSync(join(root, "dist/cloudflare/cloudflare-studio-client.d.ts"), "ok\n");

    const pending: Array<() => void> = [];
    const handle = startStudioClientWatch({
      packageRoot: root,
      debounceMs: 40,
      generate: () => new Promise<void>((resolve) => pending.push(resolve)),
    });
    try {
      expect(watchMock.watch).toHaveBeenCalledWith(
        join(root, "src"),
        { recursive: true },
        expect.any(Function)
      );
      await vi.advanceTimersByTimeAsync(80);
      expect(pending).toHaveLength(0);

      // Control event delivery: native watchers may delay or coalesce writes.
      // Neither file is imported by the browser entry; all source changes rebuild.
      changeSource("cli/cli-parser.ts");
      await vi.advanceTimersByTimeAsync(15);
      changeSource("studio/browser/leaf.ts");
      await vi.advanceTimersByTimeAsync(39);
      expect(pending).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending).toHaveLength(1);

      changeSource("studio/browser/leaf.ts");
      await vi.advanceTimersByTimeAsync(40);
      changeSource("cli/cli-parser.ts");
      await vi.advanceTimersByTimeAsync(40);
      expect(pending).toHaveLength(1);
      pending[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(pending).toHaveLength(2);
      pending[1]?.();
      await vi.advanceTimersByTimeAsync(150);
      expect(pending).toHaveLength(2);

      changeSource("studio/browser/leaf.ts");
      handle.close();
      expect(watchMock.close).toHaveBeenCalledOnce();
      changeSource("studio/browser/leaf.ts");
      await vi.advanceTimersByTimeAsync(150);
      expect(pending).toHaveLength(2);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "dist/studio/browser/entry.js",
    "dist/cloudflare/cloudflare-studio-client.js",
    "dist/cloudflare/cloudflare-studio-client.d.ts",
  ])("generates when %s is missing and keeps watching after a failure", async (missing) => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-studio-watch-"));
    mkdirSync(join(root, "src/studio/browser"), { recursive: true });
    writeFileSync(join(root, "src/studio/browser/entry.ts"), 'export const text = "Studio";\n');
    for (const output of [
      "dist/studio/browser/entry.js",
      "dist/cloudflare/cloudflare-studio-client.js",
      "dist/cloudflare/cloudflare-studio-client.d.ts",
    ]) {
      if (output === missing) continue;
      mkdirSync(join(root, output, ".."), { recursive: true });
      writeFileSync(join(root, output), "ok\n");
    }

    const generate = vi.fn(async () => {
      if (generate.mock.calls.length === 1) throw new Error("Studio client bundle failed.");
    });
    const handle = startStudioClientWatch({
      packageRoot: root,
      debounceMs: 20,
      generate,
    });
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(generate).toHaveBeenCalledOnce();
      changeSource("studio/browser/entry.ts");
      await vi.advanceTimersByTimeAsync(20);
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
