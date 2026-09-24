# Tubeless on AWS Step Functions

Run a Tubeless pipeline inside a Lambda function invoked by AWS Step Functions.
Step Functions owns the durable workflow and retries; Tubeless owns the typed
steps, progress, and result within each Lambda invocation.

```text
Step Functions Standard workflow → Lambda Task → Tubeless pipeline
                                 ← rows, count, runId, preview ←
```

The example normalizes and deduplicates rows. It includes a Lambda handler,
an Amazon States Language definition, and an AWS SAM deployment template.
The pipeline has no AWS imports. Its only host dependency is the development-only
`@types/aws-lambda` package used to check the handler's context type.

## The example

| File                                                                          | Responsibility                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`pipeline.ts`](../examples/step-functions/pipeline.ts)                       | Normalize and deduplicate rows through public Tubeless imports                       |
| [`handler.ts`](../examples/step-functions/handler.ts)                         | Validate input, correlate attempts, forward logs, and enforce a cooperative deadline |
| [`state-machine.asl.json`](../examples/step-functions/state-machine.asl.json) | Invoke Lambda synchronously, retry selected failures, and return the pipeline result |
| [`template.json`](../examples/step-functions/template.json)                   | Deploy Lambda, its log group, the state machine, and invocation permissions          |
| [`input.json`](../examples/step-functions/input.json)                         | Supply a small example job                                                           |

The state machine uses the
[optimized Lambda integration](https://docs.aws.amazon.com/step-functions/latest/dg/connect-lambda.html).
It waits for the handler and selects `$.Payload` from the integration response.
A rejected handler fails the Task; returning an object such as `{ error: ... }`
would be a successful Lambda response, so this handler throws on failure.

## Build and deploy

Install Bun, Node.js 22.6 or later, the
[AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
and AWS CLI v2. From the repository root:

```sh
bun ci
bun run build
bun build examples/step-functions/handler.ts --target node --format esm \
  --outfile .context/step-functions/handler.mjs
sam validate --lint --region us-east-1 --template-file examples/step-functions/template.json
```

Bun bundles the handler and Tubeless runtime into a single Node-compatible ESM
file. Lambda runs `handler.mjs` under `nodejs22.x`; it does not need Bun installed.
Keep this output directory dedicated to the deployment artifact.

Choose an AWS profile and region for a development account, then deploy:

```sh
export AWS_PROFILE=your-development-profile
export AWS_DEFAULT_REGION=us-east-1
aws sts get-caller-identity
sam deploy --guided --template-file examples/step-functions/template.json \
  --stack-name tubeless-step-functions-example --capabilities CAPABILITY_IAM
```

This creates billable AWS resources. SAM uploads the local code and state machine
definition and creates the required IAM roles. The state machine can invoke the
example Lambda; the Lambda needs only its basic logging permissions. The log
group retains logs for seven days. No application credentials belong in the
execution input. See [SAM deployment](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli-deploy.html).

## Start an execution

Read the deployed state machine ARN and launch the checked-in input:

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

The execution is asynchronous. Repeat `describe-execution` until it reaches a
terminal status, or open the execution in the Step Functions console. On success,
its `output` is a JSON string containing `rows: ["alpha", "beta"]`, `count: 2`,
a Tubeless `runId`, and `preview: false`.

Omitting `--name` creates a new execution name each time. Supply a stable name
when your caller needs the Standard workflow's start idempotency semantics;
completed executions cannot simply be restarted with that name. See
[`start-execution`](https://docs.aws.amazon.com/cli/latest/reference/stepfunctions/start-execution.html).

Change `dryRun` to `true` in a copy of the input to forward Tubeless's preview
control. This still starts a real, billable Step Functions execution and Lambda
invocation. The sample performs pure transformations; when adding writes, give
those steps `dryRun: "skip"` or a side-effect-free preview handler.

## Execution identity and logs

The state machine passes the complete job under `job` and constructs `host`
from `$$.Execution.Id`, `$$.State.Name`, and `$$.State.RetryCount`. Callers do not
need to construct that envelope. These are Step Functions
[context fields](https://docs.aws.amazon.com/step-functions/latest/dg/input-output-contextobject.html).

The handler validates both objects. It combines the execution ARN and state
name into a correlation ID that stays stable across retries. Every invocation
gets a fresh Tubeless `runId` and Lambda request ID. An optional `job.parentRunId`
links to a known Tubeless execution; do not use the Step Functions ARN as a
Tubeless parent. This example has one Task invocation per workflow path. Add an
item key to correlation if adapting it to a Map state.

The handler sends structured progress, logs, and trace events to Lambda's logger,
including the host identity and request ID. To follow them:

```sh
TUBELESS_FUNCTION_NAME=$(aws cloudformation describe-stacks \
  --stack-name tubeless-step-functions-example \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue | [0]" --output text)
aws logs tail "/aws/lambda/$TUBELESS_FUNCTION_NAME" --since 10m --follow
```

The template enables Lambda's
[JSON log format](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-logging.html).
Step Functions history records the Lambda Task boundary, not each Tubeless step.
CloudWatch log envelopes are not directly importable Tubeless NDJSON. To inspect
remote executions in Studio, adapt the trace exporter to retain raw `event`
objects in shared storage, one JSON object per line. Apply your application's
redaction policy before retaining them.

## Retries, deadlines, and cancellation

The Task retries transient Lambda service errors and `PipelineExecutionError`
at most twice after the initial attempt, with exponential backoff and full
jitter. Invalid payloads raise `InvalidPipelineInput`, which is not retried.
`PipelineDeadlineExceeded` and hard timeouts are also not retried by this example.
Unhandled failures leave the workflow failed; there is no catch-all success path.
See [Step Functions error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html).

A retry runs the entire Tubeless pipeline again. Its completed steps are not
individually checkpointed by Step Functions. The example's pure transformations
are safe to repeat. For writes, use business-level idempotency keys and narrow
the retry policy to failures your application can recover from. Neither an
execution ARN nor a Tubeless correlation ID makes side effects exactly-once.
Use separate Task states hosting smaller pipelines when phases need independent
durable recovery.

Lambda has a 30-second timeout, the Task has a 35-second timeout, and the workflow
has a 120-second overall limit. The handler reads Lambda's remaining time and
aborts Tubeless one second before that deadline, leaving room to report failure.
It clears the timer in `finally` so a reused Lambda environment does not inherit
it. Steps must cooperate with `context.signal`; blocking work or I/O that ignores
the signal can still hit Lambda's hard timeout. The relevant Lambda API is
[`getRemainingTimeInMillis`](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-context.html).

Stopping the Step Functions execution does not send an abort signal to an
already-running Lambda. Its current invocation can continue until completion or
timeout. Cancellation is not rollback. For jobs that need external cancellation,
implement a shared cancellation mechanism or choose a host that supports it.

## Larger workloads and local development

Keep state input and output small: Step Functions has a 256 KiB payload limit,
including the job envelope and integration result. Pass object-storage references
for larger datasets rather than embedding rows. See
[Step Functions quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html).
Lambda supports at most [15 minutes per invocation](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html).
Longer pipelines can run in an ECS task or AWS Batch job orchestrated by Step
Functions; that requires a different host adapter and deployment.

For local iteration without AWS, use the registered pipeline:

```sh
bun run tubeless -- plan --project examples/project/tubeless.project.ts step-functions-normalize
bun run tubeless -- run --project examples/project/tubeless.project.ts step-functions-normalize -- \
  --lines " Alpha " --lines "Beta" --dry-run
```

`make check` typechecks the examples, tests handler validation, retry correlation,
progress, dry runs, deadlines, failure propagation, and timer cleanup, and builds
and invokes the standalone bundle under Node. It does not deploy to AWS or
exercise IAM, CloudWatch delivery, or the managed Step Functions service. Run
`sam validate --lint` separately and verify a real execution in your development
account before adopting the deployment.

When finished with the deployed example, remove its stack:

```sh
sam delete --stack-name tubeless-step-functions-example
```
