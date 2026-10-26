import { PIPELINE_MERMAID_DIRECTIONS } from "../core/pipeline-types.js";
import { AGENT_REPL_HELP } from "./agent/commands.js";
import type { WorkbenchCommandSpec } from "./workbench-subcommand.js";

export const CLOUDFLARE_TARGET = {
  id: "cloudflare",
  description: "Worker, Durable Objects and R2 with Studio behind Cloudflare Access",
} as const;

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

const REGISTRATION_OPTIONS = {
  export: {
    type: "string",
    description: "Select a pipeline or command export when the file has more than one",
    short: "e",
    valueName: "name",
    completion: "text",
  },
  project: {
    type: "string",
    description: "Resolve a pipeline or command id from this project file",
    short: "p",
    valueName: "path",
    completion: "file",
  },
} as const;

const STEP_FILTER_OPTIONS = {
  tag: {
    type: "string",
    description: "Require a step tag (repeatable; all must match)",
    valueName: "tag",
    multiple: true,
    completion: "text",
  },
  owner: {
    type: "string",
    description: "Match step owner exactly",
    valueName: "owner",
    completion: "text",
  },
  domain: {
    type: "string",
    description: "Match step domain exactly",
    valueName: "domain",
    completion: "text",
  },
} as const;

const PROJECT_FILE_OPTION = {
  type: "string",
  description: "Project file (default: ./tubeless.project.ts)",
  short: "p",
  valueName: "path",
  completion: "file",
} as const;

const STORE_OPTION = {
  type: "string",
  description: "SQLite database (default: .tubeless/runs.sqlite)",
  valueName: "path",
  completion: "file",
} as const;

const CLOUD_HOST_OPTION = {
  type: "string",
  description: "Cloud origin (default https://cloud.tubeless.io)",
  valueName: "origin",
  completion: "text",
} as const;

/** Static CLI metadata. Parsing, help, suggestions and completion share these definitions. */
export const WORKBENCH_SPECS = {
  list: {
    name: "list",
    usage: `Usage: tubeless list [options]

List the pipelines and commands registered in a Tubeless project file, one per line
with its display name and description.
`,
    options: {
      project: PROJECT_FILE_OPTION,
      json: { type: "boolean", description: "Emit the project inventory as JSON" },
    },
  },
  validate: {
    name: "validate",
    usage: `Usage: tubeless validate [--json] <document.yaml|document.yml|document.json>

Check pipeline document structure and metadata without importing handlers.
Does not check graph semantics, registered names, or domain values. Use inspect
or plan on the compiled command module for engine validation.
YAML uses Bun's parser; duplicate mapping keys may be overwritten during parsing.
`,
    positional: "file",
    options: {
      json: { type: "boolean", description: "Emit a structured validation result" },
    },
  },
  inspect: {
    name: "inspect",
    usage: `Usage: tubeless inspect [options] <pipeline-or-command-file>

Show a registered id or exported pipeline's identity plus the default structural plan.
`,
    positional: "pipeline",
    options: {
      ...REGISTRATION_OPTIONS,
      ...STEP_FILTER_OPTIONS,
      json: { type: "boolean", description: "Emit identity and the default plan as JSON" },
    },
  },
  plan: {
    name: "plan",
    usage: `Usage: tubeless plan [options] <pipeline-or-command-file>

Preview a registered or exported pipeline without running steps or requiring domain options.
`,
    positional: "pipeline",
    options: {
      ...REGISTRATION_OPTIONS,
      target: {
        type: "string",
        description: "Select a declared target and its prerequisites (repeatable)",
        short: "t",
        valueName: "id",
        multiple: true,
        completion: "target",
      },
      step: {
        type: "string",
        description: "Select exact internal steps (repeatable)",
        short: "s",
        valueName: "id",
        multiple: true,
        completion: "step",
      },
      "dry-run": { type: "boolean", description: "Show each step's dry-run disposition" },
      explain: { type: "boolean", description: "Include target/dependency selection provenance" },
      json: { type: "boolean", description: "Emit the complete structured plan as JSON" },
    },
  },
  graph: {
    name: "graph",
    usage: `Usage: tubeless graph [options] <pipeline-or-command-file>

Generate Mermaid flowchart source from a registered or exported pipeline or command.
`,
    positional: "pipeline",
    options: {
      ...REGISTRATION_OPTIONS,
      direction: {
        type: "string",
        description: "Flowchart direction: BT, LR, RL, TB, or TD (default: TD)",
        short: "d",
        valueName: "value",
        completion: PIPELINE_MERMAID_DIRECTIONS,
      },
      ...STEP_FILTER_OPTIONS,
      metadata: { type: "boolean", description: "Include step metadata in labels" },
      descriptions: { type: "boolean", description: "Include step descriptions in node labels" },
      markdown: {
        type: "boolean",
        description: "Wrap the result in a fenced Mermaid Markdown block",
      },
    },
  },
  run: {
    name: "run",
    usage: `Usage: tubeless run [options] <pipeline-id-or-file> [-- <command-args...>]

Execute a project pipeline or a directly exported pipeline or command using its validated CLI contract.
`,
    footer: `Pass application flags after --. For command help, use: tubeless run <file> -- --help
Schema-backed pipelines infer arguments; use definePipelineCommand for custom inputs.`,
    positional: "pipeline",
    passthrough: true,
    options: {
      ...REGISTRATION_OPTIONS,
      store: {
        type: "string",
        description: "Append run events to a local SQLite database",
        valueName: "path",
        completion: "file",
      },
      trace: {
        type: "string",
        description:
          "Write NDJSON traces to a file, or - for stdout (command output then goes to stderr)",
        valueName: "path",
        completion: "file",
      },
    },
  },
  history: {
    name: "history",
    usage: `Usage: tubeless history [options] [run-id]

Show recorded pipeline runs from SQLite or an NDJSON trace.
Run details include recorded agent turns, tool calls, and child agents.
`,
    options: {
      store: STORE_OPTION,
      trace: {
        type: "string",
        description: "Read a finished NDJSON trace artifact",
        valueName: "path",
        completion: "file",
      },
      pipeline: {
        type: "string",
        description: "Filter by recorded pipeline ID",
        valueName: "id",
        completion: "text",
      },
      json: { type: "boolean", description: "Emit the projected run list or run as JSON" },
      events: { type: "boolean", description: "Emit raw store events as NDJSON" },
      clear: {
        type: "boolean",
        description: "Delete all recorded history from a SQLite store (requires --yes)",
      },
      yes: { type: "boolean", description: "Confirm --clear; there is no interactive prompt" },
    },
  },
  upgrade: {
    name: "upgrade",
    usage: `Usage: tubeless upgrade [options]

Rewrite an older SQLite run store to the current schema.

The upgrade rewrites the history file in place and cannot be undone. Versions 1
and 2 rebuild the event table, keep event ids, and rename retired PIPES_ error
codes to TUBELESS_. Version 3 adds a column. Run this before an unattended
\`tubeless run --store\` or \`tubeless ui\` so that job does not stop on an older store.
`,
    options: {
      store: STORE_OPTION,
      yes: { type: "boolean", description: "Confirm the rewrite; there is no interactive prompt" },
    },
  },
  agent: {
    name: "agent",
    usage: `Usage: tubeless agent [options]

Prompt a workspace agent, watch its pipeline execution, then prompt again.
Prompts share conversation context; each execution has fresh limits and the default tools.
`,
    footer: `REPL commands:
${AGENT_REPL_HELP}
OpenAI needs an exported OPENAI_API_KEY or --env-file. Workspace tools run with your host permissions.`,
    options: {
      model: {
        type: "string",
        description: "Model name (defaults to OPENAI_MODEL or gpt-5.4-mini)",
        valueName: "name",
        completion: "text",
      },
      "model-module": {
        type: "string",
        description: "Default-export a factory ({ model, signal, env }) => AgentModel",
        valueName: "file",
        completion: "file",
      },
      "env-file": {
        type: "string",
        description: "Read dotenv values; existing environment values take precedence",
        valueName: "file",
        completion: "file",
      },
      prompt: {
        type: "string",
        description: "Run one prompt and exit instead of opening the REPL",
        valueName: "text",
        completion: "text",
      },
      instructions: {
        type: "string",
        description: "Append instructions to the workspace agent prompt",
        valueName: "text",
        completion: "text",
      },
      "max-turns": {
        type: "string",
        description: "Decision limit per prompt (default 20)",
        valueName: "n",
        completion: "text",
      },
      "max-calls": {
        type: "string",
        description: "Tool call limit per prompt (default 100)",
        valueName: "n",
        completion: "text",
      },
      "max-concurrency": {
        type: "string",
        description: "Concurrent decisions/tools (default 1)",
        valueName: "n",
        completion: "text",
      },
      tools: {
        type: "string",
        description:
          "Comma-separated default tools to allow (default read,write,edit,bash,list,search)",
        valueName: "names",
        completion: "text",
      },
      codemode: {
        type: "boolean",
        description: "Offer one JavaScript codemode tool that calls the workspace tools",
      },
      "no-graph": {
        type: "boolean",
        description: "Hide pipeline reporting (keep model/tool logs and answers)",
      },
    },
  },
  init: {
    name: "init",
    usage: `Usage: tubeless init <target> [options]

Scaffold deployment files for a Tubeless project. Existing files are never overwritten.

Targets:
  ${CLOUDFLARE_TARGET.id.padEnd(12)} ${CLOUDFLARE_TARGET.description}
`,
    positional: [CLOUDFLARE_TARGET.id],
    options: {
      project: PROJECT_FILE_OPTION,
    },
  },
  auth: {
    name: "auth",
    usage: `Usage: tubeless auth <login|status|logout> [options]

Sign in to Tubeless Cloud with an expiring first-party session.
`,
    footer: `Credentials use the OS credential store. TUBELESS_TOKEN overrides stored sessions.`,
    subcommands: ["login", "status", "logout"],
    options: {
      host: CLOUD_HOST_OPTION,
      "no-browser": {
        type: "boolean",
        description: "Print the login URL without opening a browser",
        commands: ["login"],
      },
      json: { type: "boolean", description: "Machine-readable status", commands: ["status"] },
    },
  },
  cloud: {
    name: "cloud",
    usage: `Usage: tubeless cloud <list|run|logs> [options]

  list [--json]
  run <pipeline-name-or-slug> [--input-file <path|->] [--detach] [--json]
  run --id <cloud-pipeline-id> [--input-file <path|->] [--detach] [--json]
  logs <run-id> [--follow] [--json]

All commands accept --workspace <id>, --host <origin>, and --help.
Use a listed slug or an exact name. Quote names containing spaces.
Run watches logs by default; --detach returns after printing the run ID.
Remote runs use deployed code. Local edits and modules are never loaded.
Set up and load pipelines in the Cloud dashboard.
`,
    subcommands: ["list", "run", "logs"],
    options: {
      host: CLOUD_HOST_OPTION,
      workspace: {
        type: "string",
        description: "Select a Cloud workspace",
        valueName: "id",
        completion: "text",
      },
      json: { type: "boolean", description: "Emit machine-readable JSON" },
      id: {
        type: "string",
        description: "Select a pipeline by its exact ID",
        valueName: "cloud-pipeline-id",
        completion: "text",
        commands: ["run"],
      },
      "input-file": {
        type: "string",
        description: "Read pipeline input JSON from a file, or - for stdin",
        valueName: "path|-",
        completion: "file",
        commands: ["run"],
      },
      detach: {
        type: "boolean",
        description: "Return after printing the admitted run ID",
        commands: ["run"],
      },
      follow: {
        type: "boolean",
        description: "Watch the run until it finishes",
        commands: ["logs"],
      },
    },
  },
  ui: {
    name: "ui",
    usage: `Usage: tubeless ui [options] [project-file]

Serve the local pipeline studio from an append-only SQLite run store or a
finished NDJSON trace. Load pipelines from a project, or register
pipeline or definePipelineCommand modules directly, and only with a writable SQLite store.
`,
    positional: "file",
    options: {
      command: {
        type: "string",
        description: "Register a launchable pipeline or command (repeatable)",
        valueName: "path",
        multiple: true,
        completion: "file",
      },
      export: {
        type: "string",
        description: "Select the export when registering exactly one command",
        short: "e",
        valueName: "name",
        completion: "text",
      },
      store: STORE_OPTION,
      trace: {
        type: "string",
        description: "Read a finished NDJSON trace artifact (history-only)",
        valueName: "path",
        completion: "file",
      },
      host: {
        type: "string",
        description: "Bind address (default: 127.0.0.1)",
        valueName: "value",
        completion: "text",
      },
      port: {
        type: "string",
        description: "HTTP port (default: 4317)",
        valueName: "number",
        completion: "text",
      },
      "public-url": {
        type: "string",
        description:
          "Host behind an authenticated gateway (requires TUBELESS_STUDIO_GATEWAY_TOKEN)",
        valueName: "url",
        completion: "text",
      },
    },
  },
  completion: {
    name: "completion",
    usage: `Usage: tubeless completion <bash|zsh|fish>

Print a shell completion script. It completes commands, flags, project
pipeline IDs, plan targets and steps, and pipeline command flags after
"tubeless run <id> --".

Enable it in the current shell:
  bash  eval "$(tubeless completion bash)"
  zsh   source <(tubeless completion zsh)
  fish  tubeless completion fish | source

Add the same line to ~/.bashrc, ~/.zshrc (after compinit), or
~/.config/fish/config.fish to keep it.
`,
    positional: COMPLETION_SHELLS,
    options: {},
  },
} as const satisfies Readonly<Record<string, WorkbenchCommandSpec>>;
