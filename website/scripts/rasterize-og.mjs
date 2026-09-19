import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(websiteRoot, "..");
const svg = readFileSync(join(repoRoot, "docs/assets/social.svg"), "utf8");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const work = mkdtempSync(join(tmpdir(), "tubeless-og-"));
const htmlPath = join(work, "social.html");
const pngPath = join(work, "og.png");
const jpgPath = join(websiteRoot, "public/og.jpg");

writeFileSync(
  htmlPath,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800&family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet" />
    <style>
      html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #f7f5ef; }
      svg { display: block; width: 1200px; height: 630px; }
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
    "--force-device-scale-factor=1",
    "--window-size=1200,630",
    "--virtual-time-budget=8000",
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ],
  { encoding: "utf8" },
);
if (shot.status !== 0) {
  rmSync(work, { recursive: true, force: true });
  throw new Error(shot.stderr || shot.stdout || "Chrome screenshot failed");
}

const convert = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", pngPath, "--out", jpgPath], {
  encoding: "utf8",
});
rmSync(work, { recursive: true, force: true });
if (convert.status !== 0) {
  throw new Error(convert.stderr || "JPEG conversion failed");
}
console.log(`Wrote ${jpgPath}`);
