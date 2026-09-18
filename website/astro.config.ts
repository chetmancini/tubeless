import { defineConfig } from "astro/config";
import remarkDocLinks, { remarkRemoveDocTitle } from "./src/lib/doc-links";

export default defineConfig({
  site: "https://tubeless.io",
  trailingSlash: "never",
  markdown: {
    remarkPlugins: [remarkDocLinks, remarkRemoveDocTitle],
    shikiConfig: { theme: "github-dark" },
  },
});
