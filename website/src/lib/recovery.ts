import { absUrl } from "./paths";

export function recoveryMarkdown(): string {
  return `# 404 — Page not found

This path does not exist on the Tubeless documentation site. Choose a known page:

- [Agent documentation index](${absUrl("llms.txt")})
- [Documentation index](${absUrl("docs")})
- [Sitemap](${absUrl("sitemap.xml")})

Read the index before guessing another URL.
`;
}
