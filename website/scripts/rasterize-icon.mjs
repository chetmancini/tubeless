import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(websiteRoot, "..");
const svg = readFileSync(join(repoRoot, "docs/assets/logo.svg"), "utf8");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const size = 180;
const work = mkdtempSync(join(tmpdir(), "tubeless-icon-"));
const htmlPath = join(work, "icon.html");
const shotPath = join(work, "icon.png");
const pngPath = join(websiteRoot, "public/apple-touch-icon.png");

writeFileSync(
  htmlPath,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; width: ${size}px; height: ${size}px; overflow: hidden; background: #e6e4de; }
      svg { display: block; width: ${size}px; height: ${size}px; }
    </style>
  </head>
  <body>${svg}</body>
</html>`,
);

const shot = spawnSync(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--window-size=${size},${size}`,
    "--virtual-time-budget=2000",
    `--screenshot=${shotPath}`,
    `file://${htmlPath}`,
  ],
  { encoding: "utf8" },
);
if (shot.status !== 0) {
  rmSync(work, { recursive: true, force: true });
  throw new Error(shot.stderr || shot.stdout || "Chrome screenshot failed");
}

const convert = spawnSync("sips", ["-z", String(size), String(size), shotPath, "--out", pngPath], {
  encoding: "utf8",
});
rmSync(work, { recursive: true, force: true });
if (convert.status !== 0) {
  throw new Error(convert.stderr || "PNG resize failed");
}
console.log(`Wrote ${pngPath}`);
