import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateStudioClient } from "./generate-studio-client.mjs";

// `tsc --watch` never emits the Studio browser bundle. tsconfig excludes the
// browser entry so a compile cannot overwrite the generator's output. Rebuild
// on source changes. ponytail: accept extra rebuilds; use bundler dependency
// metadata if filtering becomes necessary.

const defaultPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDebounceMs = 50;
const browserBundle = "dist/studio/browser/entry.js";
const cloudflareBundle = "dist/cloudflare/cloudflare-studio-client.js";

/** Rebuild the Studio client when any file under src changes. */
export function startStudioClientWatch({
  packageRoot = defaultPackageRoot,
  generate = generateStudioClient,
  debounceMs = defaultDebounceMs,
} = {}) {
  let timer;
  let running = false;
  let queued = false;
  let closed = false;

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void rebuild();
    }, debounceMs);
  };

  const rebuild = async () => {
    if (closed) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await generate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
    } finally {
      running = false;
      if (queued && !closed) {
        queued = false;
        void rebuild();
      }
    }
  };

  const stop = openWatch(resolve(packageRoot, "src"), schedule);
  if (
    !existsSync(resolve(packageRoot, browserBundle)) ||
    !existsSync(resolve(packageRoot, cloudflareBundle))
  ) {
    schedule();
  }

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      stop();
    },
  };
}

function openWatch(root, onChange) {
  const watchers = [];
  const watchedDirs = new Set();
  let recursive = true;

  const deliver = (dir, filename) => {
    if (!filename) {
      onChange(undefined);
      return;
    }
    const changed = resolve(dir, filename);
    if (!recursive) watchNewDirectory(changed);
    onChange(changed);
  };

  try {
    watchers.push(arm(root, { recursive: true }, (filename) => deliver(root, filename)));
  } catch (error) {
    // Node's recursive fs.watch is missing on some Linux builds.
    if (error?.code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw error;
    recursive = false;
    watchDirectory(root);
  }

  return () => {
    for (const watcher of watchers) watcher.close();
  };

  function watchNewDirectory(path) {
    try {
      if (statSync(path).isDirectory()) watchDirectory(path);
    } catch {
      // The path can disappear between the event and the stat.
    }
  }

  function watchDirectory(dir) {
    if (watchedDirs.has(dir)) return;
    watchedDirs.add(dir);
    watchers.push(arm(dir, {}, (filename) => deliver(dir, filename)));
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        watchDirectory(join(dir, entry.name));
      }
    }
  }
}

function arm(dir, options, onFilename) {
  const watcher = watch(dir, options, (_event, filename) => {
    onFilename(filename ?? undefined);
  });
  watcher.on("error", (error) => {
    process.stderr.write(`Studio client watch: ${error.message}\n`);
  });
  return watcher;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.stdout.write("Watching Studio client sources\n");
  startStudioClientWatch();
}
