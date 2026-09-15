# Agent skill pack

Install Tubeless guidance into your coding agent from the repository:

```sh
npx skills add chetmancini/tubeless
```

The installer lets you choose skills and agents. To install only the conversion
skill:

```sh
npx skills add chetmancini/tubeless --skill tubeless-make-pipeline
```

The [Skills CLI](https://github.com/vercel-labs/skills#source-formats) accepts a
repository source such as `owner/repo`. It does not resolve the npm package name
in `npx skills add tubeless`; use `chetmancini/tubeless`.

## Included skills

| Skill                                                                 | Use it for                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`tubeless`](../skills/tubeless/SKILL.md)                             | Authoring and reviewing pipelines, commands, and catalogs  |
| [`tubeless-make-pipeline`](../skills/tubeless-make-pipeline/SKILL.md) | Converting existing code into a structured, typed pipeline |

Each skill works on its own in a consumer repository. Both use documentation
and examples from the installed Tubeless package, with public docs as a fallback.
Installing the skills does not install the Tubeless runtime into your project.

## Convert an existing workflow

Ask your agent:

> Use tubeless-make-pipeline to convert scripts/import-customers.ts into a typed
> Tubeless pipeline. Preserve the existing caller and behavior, keep validation
> before writes, and verify dry runs with fake I/O.

The skill traces the existing code before choosing step boundaries. It keeps
domain helpers, makes dependencies and failure policy explicit, preserves type
inference, and checks behavior after connecting the pipeline to its caller.
You can also invoke it by name in an agent that supports explicit skills, such
as `$tubeless-make-pipeline` in Codex.

## Inspect or install a local pack

List the available skills without installing them:

```sh
npx skills add chetmancini/tubeless --list
```

From a Tubeless checkout, use `npx skills add . --list` to inspect local changes.
The npm artifact also includes `skills/`; when the package is installed at
`node_modules/tubeless`, you can install from it:

```sh
npx skills add ./node_modules/tubeless
```
