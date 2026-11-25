const JSON_COMMANDS = ["list", "run", "inspect", "cancel", "follow", "logs", "artifacts"] as const;
const DOWNLOAD_COMMANDS = ["download", "manifest"] as const;
const SERVICE_COMMANDS = [...JSON_COMMANDS, ...DOWNLOAD_COMMANDS] as const;

export const CLOUD_HOST_OPTION = {
  type: "string",
  description: "Cloud origin (default https://cloud.tubeless.io)",
  valueName: "origin",
  completion: "text",
} as const;

export const CLOUD_SPEC = {
  name: "cloud",
  description: "Run and inspect Cloud pipelines, download retained files, or reproduce a check",
  usage: `Usage: tubeless cloud <command> [options]

  list [--json]
  run <pipeline-name-or-slug> [--ref <branch|tag|sha>] [--input-file <path|->] [--detach|--poll] [--json]
  run --id <cloud-pipeline-id> [--ref <branch|tag|sha>] [--input-file <path|->] [--detach|--poll] [--json]
  inspect <run-id> [--json]
  cancel <run-id> [--json]
  follow <run-id> [--cursor <cursor>|--poll] [--json]
  logs <run-id> [--follow [--cursor <cursor>|--poll]] [--json]
  artifacts <run-id> [--json]
  download <run-id> <artifact-name> --output <path>
  manifest <run-id> --output <path>
  reproduce --execute <manifest.json>

Cloud service commands accept --workspace <id> and --host <origin>.
Run streams progress and output by default; --detach returns the admission.
Inspect reads the retained run. Cancel requests cancellation and reports status.
Ctrl-C stops observation and leaves the run active. Use --poll on older services.
Automation uses TUBELESS_TOKEN and --workspace. Run --id with --detach needs run scope.
Inspection and observation need read scope. Cancellation needs cancel and read.
Use --ref or --source to select GitHub source. The default is the branch HEAD.
Reuse --idempotency-key with the same pipeline/input/source after uncertain admission.
Set up pipelines in the Cloud dashboard. Cloud runs use the admitted GitHub source.

Artifact metadata and manifests need read scope. Artifact bytes also need artifacts:read.
Downloads require a new output path. Manifest download only validates and saves the file.
Reproduce runs a saved manifest locally without Cloud login. It emits JSON and
requires Git, Node 24 and Bun 1.4.4 on PATH. Only execute revisions you trust.
`,
  subcommands: [...SERVICE_COMMANDS, "reproduce"],
  subcommandPositionals: { reproduce: "file" },
  options: {
    host: { ...CLOUD_HOST_OPTION, commands: SERVICE_COMMANDS },
    workspace: {
      type: "string",
      description: "Select a Cloud workspace",
      valueName: "id",
      completion: "text",
      commands: SERVICE_COMMANDS,
    },
    json: {
      type: "boolean",
      description: "Emit machine-readable JSON",
      commands: JSON_COMMANDS,
    },
    output: {
      type: "string",
      description: "Save the retained file to a new local path",
      valueName: "path",
      completion: "file",
      commands: DOWNLOAD_COMMANDS,
    },
    execute: {
      type: "boolean",
      description: "Authorize running the pinned repository source locally",
      commands: ["reproduce"],
    },
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
    source: {
      type: "string",
      description: "Advanced source selector as inline JSON, @file, or - for stdin; excludes --ref",
      valueName: "json|@path|-",
      completion: "text",
      commands: ["run"],
    },
    ref: {
      type: "string",
      description: "GitHub branch, tag, full or short SHA; excludes --source",
      valueName: "branch|tag|sha",
      completion: "text",
      commands: ["run"],
    },
    "idempotency-key": {
      type: "string",
      description: "Reuse an admission key with identical pipeline, input and source",
      valueName: "key",
      completion: "text",
      commands: ["run"],
    },
    follow: {
      type: "boolean",
      description: "Watch the run until it finishes",
      commands: ["logs"],
    },
    cursor: {
      type: "string",
      description: "Resume streaming from the last acknowledged cursor",
      valueName: "cursor",
      completion: "text",
      commands: ["follow", "logs"],
    },
    poll: {
      type: "boolean",
      description: "Explicitly poll retained status and logs instead of streaming",
      commands: ["run", "follow", "logs"],
    },
  },
} as const;
