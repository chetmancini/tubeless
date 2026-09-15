import { createHighlighter } from "shiki";

const highlighter = await createHighlighter({
  themes: ["github-dark"],
  langs: ["typescript", "shellscript", "json", "text"],
});

const languageAliases: Record<string, string> = {
  bash: "shellscript",
  plaintext: "text",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  txt: "text",
};

const supportedLanguages = new Set(["typescript", "shellscript", "json", "text"]);

export function highlightCode(code: string, language?: string): string {
  const requestedLanguage = language?.split(/\s+/, 1)[0] ?? "text";
  const normalizedLanguage = languageAliases[requestedLanguage] ?? requestedLanguage;
  const lang = supportedLanguages.has(normalizedLanguage) ? normalizedLanguage : "text";

  return highlighter.codeToHtml(code, { lang, theme: "github-dark" });
}
