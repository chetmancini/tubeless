# Tubeless on AWS Step Functions

Run a Tubeless pipeline inside a Lambda function invoked by AWS Step Functions.
Step Functions owns the durable workflow and retries; Tubeless owns the typed
steps, progress, and result within each Lambda invocation.

```text
Step Functions Standard workflow → Lambda Task → Tubeless pipeline
                                 ← rows, count, runId, preview ←
```

## The example

| File                                                                          | Responsibility                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`pipeline.ts`](../examples/step-functions/pipeline.ts)                       | The pipeline, with no AWS imports                                       |
| [`handler.ts`](../examples/step-functions/handler.ts)                         | Validate input, correlate attempts, forward logs, enforce a deadline    |
| [`state-machine.asl.json`](../examples/step-functions/state-machine.asl.json) | Invoke Lambda synchronously, retry selected failures, return the result |
| [`template.json`](../examples/step-functions/template.json)                   | SAM template: Lambda, log group, state machine, permissions             |
| [`input.json`](../examples/step-functions/input.json)                         | Example job                                                             |

The state machine uses the
[optimized Lambda integration](https://docs.aws.amazon.com/step-functions/latest/dg/connect-lambda.html)
and selects `$.Payload`. The handler throws on failure: returning
`{ error: ... }` would be a successful Lambda response.

## Setup

Install Bun, Node.js 22.18 or later, the
[AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
and AWS CLI v2. From the repository root:

```sh
bun ci
bun run build
bun build examples/step-functions/handler.ts --target node --format esm \
  --outfile .context/step-functions/handler.mjs
sam validate --lint --region us-east-1 --template-file examples/step-functions/template.json
```

Bun bundles the handler and runtime into one ESM file for `nodejs22.x`; Lambda
does not need Bun. Keep that output directory dedicated to the artifact. Deploy
to a development account (this creates billable resources and IAM roles):

```sh
export AWS_PROFILE=your-development-profile
export AWS_DEFAULT_REGION=us-east-1
aws sts get-caller-identity
sam deploy --guided --template-file examples/step-functions/template.json \
  --stack-name tubeless-step-functions-example --capabilities CAPABILITY_IAM
```

Start an execution and read its result:

```sh
TUBELESS_STATE_MACHINE_ARN=$(aws cloudformation describe-stacks \
  --stack-name tubeless-step-functions-example \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue | [0]" --output text)

TUBELESS_EXECUTION_ARN=$(aws stepfunctions start-execution \
  --state-machine-arn "$TUBELESS_STATE_MACHINE_ARN" \
  --input file://examples/step-functions/input.json \
  --query executionArn --output text)

aws stepfunctions describe-execution --execution-arn "$TUBELESS_EXECUTION_ARN"
```

Repeat `describe-execution` until it is terminal; `output` is a JSON string with
`rows: ["alpha", "beta"]`, `count: 2`, a Tubeless `runId`, and `preview: false`.
Without `--name` each start gets a new name; supply a stable name when you need
Standard-workflow start idempotency
([`start-execution`](https://docs.aws.amazon.com/cli/latest/reference/stepfunctions/start-execution.html)).
Keep credentials out of execution input. To follow logs:

```sh
TUBELESS_FUNCTION_NAME=$(aws cloudformation describe-stacks \
  --stack-name tubeless-step-functions-example \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue | [0]" --output text)
aws logs tail "/aws/lambda/$TUBELESS_FUNCTION_NAME" --since 10m --follow
```

Remove the stack when finished:

```sh
sam delete --stack-name tubeless-step-functions-example
```

## How Tubeless maps to Step Functions

- **Identity:** the state machine passes the job under `job` and builds `host`
  from `$$.Execution.Id`, `$$.State.Name`, and `$$.State.RetryCount`
  ([context object](https://docs.aws.amazon.com/step-functions/latest/dg/input-output-contextobject.html)),
  so callers send only the job. Correlation (execution ARN plus state name) is
  stable across retries; each invocation gets a fresh `runId`. Do not use the
  execution ARN as `parentRunId`. Add an item key to correlation when adapting
  to a Map state.
- **Logs:** progress, logs, and traces go to Lambda's logger (JSON format).
  Step Functions history records the Task, not each Tubeless step. CloudWatch
  envelopes are not importable NDJSON; for Studio, keep raw events in shared
  storage with your own exporter, after redaction.
- **Payload limit:** Step Functions caps state payloads at 256 KiB
  ([quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html)).
  Pass object-storage references for larger data.
- **Duration:** Lambda allows at most
  [15 minutes](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html).
  Longer pipelines need an ECS or AWS Batch host adapter.

## Retries, deadlines, and cancellation

- **Retries:** the Task retries transient Lambda errors and
  `PipelineExecutionError` at most twice with exponential backoff and jitter.
  `InvalidPipelineInput`, `PipelineDeadlineExceeded`, and hard timeouts are not
  retried. A retry reruns the whole pipeline; Step Functions does not checkpoint
  Tubeless steps. Use business-level idempotency keys for writes and narrow the
  retry policy to recoverable failures. For independent durable recovery, use
  separate Task states hosting smaller pipelines
  ([error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)).
- **Deadlines:** Lambda times out at 30 seconds, the Task at 35, the workflow at 120. The handler aborts Tubeless one second before Lambda's remaining time
  ([`getRemainingTimeInMillis`](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-context.html))
  and clears its timer in `finally`. Steps must forward `context.signal`, or
  blocking work can still hit the hard timeout.
- **Cancellation:** stopping an execution does not signal an already-running
  Lambda, which continues until it finishes or times out. For external
  cancellation, build a shared cancellation mechanism.
- **Dry runs:** `dryRun: true` in the input still starts a billable execution.
  Mark writes `dryRun: "skip"` or provide a preview handler. To preview without
  AWS:

```sh
bun run tubeless -- plan --project examples/project/tubeless.project.ts step-functions-normalize
bun run tubeless -- run --project examples/project/tubeless.project.ts step-functions-normalize -- \
  --lines " Alpha " --lines "Beta" --dry-run
```

`make check` does not deploy or exercise IAM, CloudWatch, or Step Functions;
verify a real execution in a development account before adopting this.

## Host-owned output recovery

This adapter retains the whole-attempt retry behavior described above. To reuse
individual step outputs across attempts, add host-owned persistence, compatibility
checks, loading, and `suppliedOutputs` explicitly. Adapt the
[fresh-host recovery recipe](./step-output-recovery.md) and reconcile uncertain
side effects with business idempotency keys before retrying.
