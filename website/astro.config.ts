import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";
import { docLinks, removeDocTitle } from "./src/lib/doc-links";

export default defineConfig({
  site: "https://tubeless.io",
  trailingSlash: "never",
  // Astro 7 defaults to JSX whitespace rules, which drop the space between
  // inline elements; keep HTML-aware compression to preserve the layout.
  compressHTML: true,
  vite: {
    define: {
      __REPO_ROOT__: JSON.stringify(fileURLToPath(new URL("../", import.meta.url))),
    },
  },
  markdown: {
    processor: satteri({ mdastPlugins: [docLinks, removeDocTitle] }),
    shikiConfig: { theme: "github-dark" },
  },
});
