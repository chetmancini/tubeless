# Agent skill pack

Install Tubeless guidance into your coding agent from the repository:

```sh
npx skills add chetmancini/tubeless
```

The installer lets you choose skills and agents. To install only the conversion
skill, add `--skill tubeless-make-pipeline`; add `--list` to inspect the pack
without installing. The [Skills CLI](https://github.com/vercel-labs/skills#source-formats)
does not resolve the npm package name; use `chetmancini/tubeless`. From a
checkout or an installed package, use `npx skills add .` or
`npx skills add ./node_modules/tubeless`.

## Included skills

| Skill                                                                 | Use it for                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`tubeless`](../skills/tubeless/SKILL.md)                             | Authoring and reviewing pipelines, commands, and projects  |
| [`tubeless-make-pipeline`](../skills/tubeless-make-pipeline/SKILL.md) | Converting existing code into a structured, typed pipeline |

Each skill works on its own in a consumer repository and reads documentation and
examples from the installed Tubeless package, with public docs as a fallback.
Installing the skills does not install the Tubeless runtime.

## Convert an existing workflow

> Use tubeless-make-pipeline to convert scripts/import-customers.ts into a typed
> Tubeless pipeline. Preserve the existing caller and behavior, keep validation
> before writes, and verify dry runs with fake I/O.

The skill traces the existing code before choosing step boundaries, keeps domain
helpers, makes dependencies and failure policy explicit, and checks behavior after
connecting the pipeline to its caller. Agents with explicit skill invocation, such
as Codex, accept `$tubeless-make-pipeline`.
