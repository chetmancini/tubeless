import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

const execFileAsync = promisify(execFile);
const websiteRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const astroCli = join(websiteRoot, "node_modules", ".bin", "astro");
function analyticsBootstrap(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(([, script]) => script)
    .find((script) => script.includes("/static/array.js"));
}

async function buildWith(config) {
  // Astro renames prerendered assets into outDir, which fails across filesystems
  // (EXDEV) when the OS temp directory is a separate mount, as on some CI runners.
  const scratch = join(websiteRoot, ".astro");
  await mkdir(scratch, { recursive: true });
  const outDir = await mkdtemp(join(scratch, "posthog-test-"));
  const env = {
    ...process.env,
    PUBLIC_POSTHOG_HOST: config.apiHost ?? "",
    PUBLIC_POSTHOG_KEY: config.projectKey ?? "",
  };

  try {
    await execFileAsync(process.execPath, [astroCli, "build", "--outDir", outDir], {
      cwd: websiteRoot,
      env,
    });
    return await readFile(join(outDir, "index.html"), "utf8");
  } finally {
    await rm(outDir, { force: true, recursive: true });
  }
}

test("an analytics-disabled build omits PostHog", async () => {
  const html = await buildWith({});
  assert.equal(analyticsBootstrap(html), undefined);
  assert.doesNotMatch(html, /posthog\.com\/static\/array\.js/);
});

test("an analytics-enabled build uses the regional asset host", async () => {
  const config = {
    apiHost: "https://us.i.posthog.com",
    assetHost: "https://us-assets.i.posthog.com",
    projectKey: "phc_test",
  };

  const bootstrap = analyticsBootstrap(await buildWith(config));
  assert.ok(bootstrap, "The configured build includes an analytics bootstrap");
  const scripts = [];
  const browser = {
    document: {
      createElement: () => ({}),
      getElementsByTagName: () => [{
        parentNode: { insertBefore: (script) => scripts.push(script) },
      }],
    },
  };
  browser.window = browser;
  runInNewContext(bootstrap, browser, { timeout: 1000 });

  assert.deepEqual(scripts.map(({ src }) => src), [config.assetHost + "/static/array.js"]);
  const [[token, options]] = browser.posthog._i;
  assert.equal(token, config.projectKey);
  assert.equal(options.api_host, config.apiHost);
  assert.equal(options.autocapture, false);
  assert.equal(options.disable_session_recording, true);
});

test("a partial analytics configuration fails the build", async () => {
  await assert.rejects(
    buildWith({ projectKey: "phc_test" }),
    (error) =>
      error instanceof Error &&
      `${error.stdout ?? ""}${error.stderr ?? ""}`.includes(
        "PUBLIC_POSTHOG_KEY and PUBLIC_POSTHOG_HOST must be set together",
      ),
  );
});
