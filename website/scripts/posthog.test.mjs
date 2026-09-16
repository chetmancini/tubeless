import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const projectKey = process.env.PUBLIC_POSTHOG_KEY?.trim();
const apiHost = process.env.PUBLIC_POSTHOG_HOST?.trim().replace(/\/+$/, "");

test("the production artifact matches the PostHog build configuration", () => {
  if (projectKey && apiHost) {
    assert.match(html, /window\.__posthog_initialized/);
    assert.ok(html.includes(JSON.stringify(projectKey)));
    assert.ok(html.includes(JSON.stringify(apiHost)));
    assert.match(html, /autocapture:\s*false/);
    assert.match(html, /disable_session_recording:\s*true/);
    return;
  }

  assert.doesNotMatch(html, /window\.__posthog_initialized/);
});
