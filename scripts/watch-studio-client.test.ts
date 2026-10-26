import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startStudioClientWatch } from "./watch-studio-client.mjs";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCount(calls: readonly unknown[], count: number) {
  const start = Date.now();
  while (calls.length < count) {
    if (Date.now() - start > 2000) {
      throw new Error(`expected ${count} generates, saw ${calls.length}`);
    }
    await delay(10);
  }
}

describe("startStudioClientWatch", () => {
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

    const pending: Array<() => void> = [];
    let warmup = true;
    const handle = startStudioClientWatch({
      packageRoot: root,
      debounceMs: 40,
      generate: () =>
        new Promise<void>((resolve) => {
          if (warmup) resolve();
          else pending.push(resolve);
        }),
    });
    try {
      // A watch started just after the fixture writes can still observe them.
      await delay(400);
      warmup = false;
      await delay(80);
      expect(pending).toHaveLength(0);

      // Neither file is imported by the browser entry; all source changes rebuild.
      writeFileSync(join(root, "src/cli/cli-parser.ts"), "export const n = 2;\n");
      await delay(15);
      const leaf = join(root, "src/studio/browser/leaf.ts");
      writeFileSync(leaf, 'export const label = "Studio 2";\n');
      await waitForCount(pending, 1);
      await delay(80);
      expect(pending).toHaveLength(1);

      writeFileSync(leaf, 'export const label = "Studio 4";\n');
      await delay(120);
      expect(pending).toHaveLength(1);
      pending[0]?.();
      await waitForCount(pending, 2);
      pending[1]?.();
      await delay(150);
      expect(pending).toHaveLength(2);

      handle.close();
      writeFileSync(leaf, 'export const label = "Studio 5";\n');
      await delay(150);
      expect(pending).toHaveLength(2);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates at startup when a bundle is missing and keeps watching after a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "tubeless-studio-watch-"));
    mkdirSync(join(root, "src/studio/browser"), { recursive: true });
    mkdirSync(join(root, "dist/cloudflare"), { recursive: true });
    writeFileSync(join(root, "src/studio/browser/entry.ts"), 'export const text = "Studio";\n');
    writeFileSync(join(root, "dist/cloudflare/cloudflare-studio-client.js"), "ok\n");

    const calls: string[] = [];
    const handle = startStudioClientWatch({
      packageRoot: root,
      debounceMs: 20,
      generate: async () => {
        calls.push("run");
        if (calls.length === 1) throw new Error("Studio client bundle failed.");
      },
    });
    try {
      await waitForCount(calls, 1);
      writeFileSync(join(root, "src/studio/browser/entry.ts"), 'export const text = "Studio 2";\n');
      await waitForCount(calls, 2);
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
