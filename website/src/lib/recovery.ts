import { absUrl } from "./paths";

export function recoveryMarkdown(): string {
  return `# 404 — Page not found

This path does not exist on the Tubeless documentation site. Use one of these links:

- [Agent documentation index](${absUrl("llms.txt")})
- [Documentation index](${absUrl("docs")})
- [Sitemap](${absUrl("sitemap.xml")})

The documentation index lists the available pages.
`;
}
