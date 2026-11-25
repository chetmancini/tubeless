# GitHub Action

Plan a pipeline on a pull request. The action calls `tubeless plan` and
`tubeless graph`, then publishes that plan and a Mermaid graph in the job
summary and, on a pull request, in one sticky comment. `dry-run` and `run`
also call `tubeless run`. The action does not reimplement planning or diagrams.

It installs Node.js and Bun 1.3.14, then runs `tubeless` from
`node_modules/.bin` when this checkout has it, from
`dist/workbench/workbench-launcher.js` when that build exists, and otherwise
with `bunx tubeless`. A file that imports `tubeless` still needs the package
installed in the project. `plan` does not require domain options and works for
a pipeline the CLI can load. `dry-run` and `run` call `tubeless run`, so the
target must be a schema-backed project pipeline or a `definePipelineCommand`,
and the action passes no application flags.

## Usage

```yaml
name: plan

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"
      - run: bun install
      - uses: chetmancini/tubeless@v0
        with:
          pipeline: import
          mode: plan
```

`pipeline` is a project pipeline id or a file path, the same value you would
pass to `tubeless plan`. This repository's
[dogfood workflow](https://github.com/chetmancini/tubeless/blob/main/.github/workflows/github-action.yml)
checks out the library, builds it, and calls the action with `./` on
[`examples/typed-import.ts`](../examples/typed-import.ts).

| Input               | Default | Effect                                                                                          |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `pipeline`          |         | Required pipeline id or file                                                                    |
| `mode`              | `plan`  | `plan`, `dry-run`, or `run`                                                                     |
| `node-version`      | `22`    | Node.js version passed to `actions/setup-node`                                                  |
| `working-directory` | `.`     | Directory the CLI runs in                                                                       |
| `comment`           | `true`  | Post or update one sticky pull request comment. Skipped when the workflow is not a pull request |
| `summary`           | `true`  | Append the same Markdown to the job summary                                                     |
| `cloud-token`       |         | Reserved for Cloud dispatch. See below                                                          |

| Mode      | Commands                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `plan`    | `tubeless plan <pipeline>` and `tubeless graph <pipeline>`                                                    |
| `dry-run` | `tubeless plan --dry-run <pipeline>`, `tubeless graph <pipeline>`, and `tubeless run <pipeline> -- --dry-run` |
| `run`     | `tubeless plan <pipeline>`, `tubeless graph <pipeline>`, and `tubeless run <pipeline>`                        |

The comment and the job summary use the same body: the plan, a fenced Mermaid
graph, and a footer linking to [Tubeless](https://tubeless.io) and
[Schedule this on Tubeless Cloud](https://cloud.tubeless.io). A later run on the same pull request updates the comment that
`github-actions[bot]` posted for that pipeline. A person's comment that quotes
the report is left unchanged.
Grant `pull-requests: write` when `comment` is true. The action passes that
workflow's `github.token` to the comment request. The action sets the `plan`
and `mermaid` outputs from the CLI stdout.

## Tubeless Cloud

`cloud-token` applies only when `mode` is `run`. [CLI](./cli.md#tubeless-cloud)
documents `tubeless cloud run`. It does not document a public Cloud HTTP API,
and the client in `src/workbench/cloud` labels that transport as internal. The
action therefore does not dispatch a Cloud run. With a non-empty `cloud-token`
and `mode: run`, it still publishes the local plan and Mermaid graph, skips
both the Cloud call and the local run, and fails. The skipped branch is marked
`TODO(tubeless-cloud)` in
[`action/action.ts`](https://github.com/chetmancini/tubeless/blob/main/action/action.ts).

Marketplace reads the root
[`action.yml`](https://github.com/chetmancini/tubeless/blob/main/action.yml) on a public repository.
Publish it from a GitHub release whose tag contains that file: open a new
release, choose the tag, check **Publish this Action to the GitHub Marketplace**,
accept the Marketplace developer agreement, pick a category, and publish the
release. Do not point the listing at a tag created before `action.yml` existed.
