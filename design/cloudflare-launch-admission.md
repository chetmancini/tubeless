# Self-hosted Cloudflare launch admission

Issue: [#288](https://github.com/chetmancini/tubeless/issues/288).
Attribution and optional input history follow separately in
[#335](https://github.com/chetmancini/tubeless/issues/335).

`createCloudflareApp` exposes trusted `launch` and `getLaunch` capabilities without
adding HTTP routes. The application supplies its own cron or queue handler and
awaits admission. The existing browser protocol still acknowledges a recorded root
start and has no caller-key replay contract.

## Persistent identity

One Studio binding/object owns one idempotency-key namespace across commands and
deployments. New admissions require an explicit immutable app `deploymentId`.
Worker and Studio must agree on project/deployment identity. Change the deployment
ID whenever code or execution configuration changes; it is an operator assertion,
not binary attestation. An unspecified identity cannot prove compatibility.

The shared command adapter validates submissions and supplies normalized defaults,
retaining only declared parameters. The CLI parser's synthetic internal values
are not necessarily accepted inputs. Admission normalizes JSON numbers explicitly
so dispatched values and their digest agree, without decoding its own serialized intent.
Hash the canonical project ID, command ID, normalized values/controls, and execution
budget with Web Crypto SHA-256. Store the deployment ID separately alongside that
digest. Object keys sort, array order remains significant, and undefined optional
parameters are omitted. Apply Studio's wire bounds and a 64-KiB normalized-intent
bound before committing admission.

`tubeless_launch_admissions` maps each key to one launch, digest, and deployment.
Reservation and creation of the corresponding existing launch row share one SQLite
transaction through the typed admission-storage port. Concurrent contenders recheck
the binding inside that transaction. Storage returns the original record; the
admission policy alone decides whether it matches or conflicts.
Only its creator dispatches; matching contenders return the original immutable
`{ accepted: true, launchId }` receipt. Changed intent or deployment conflicts with
the existing launch ID. A read checks existing command/deployment identity before
revalidating parameters, so removed commands cannot silently acquire a fresh launch.

Keys have no automatic expiration. Event-history clearing preserves both launch
rows and admission records. This deliberately favors safe redelivery over bounded
key retention; a future explicit retention policy must preserve active keys and
document when replay guarantees end. Deleting the Studio object's storage loses
the namespace. Full raw values remain in the existing transient execution job;
only explicitly allowlisted normalized inputs enter the separate launch-history
record. Attribution and saved inputs commit with first admission and are never
overwritten on replay. History deletion removes them with events, preserving keys.

## Dispatch and recovery

Arrange the Studio reconciliation alarm before committing a new admission. If
alarm setup fails, do not reserve or dispatch. If admission commits but the reply
is lost, the same key recovers its identity without another dispatch. A crash
between that commit and dispatch leaves an unstarted launch for reconciliation to
fail; admission does not promise successful execution.

`hosting/launch-admission.ts` owns submission policy; the Cloudflare Studio object
supplies its alarm capability. Admission returns a job only to the reservation creator; the Studio object owns dispatch and returns a receipt without that internal job. The shared command adapter owns
parameter parsing, while the coordinator owns dispatch/failure fencing.
`startPrepared` dispatches an already-persisted launch after target-owned recovery
has been arranged. The browser path shares durable admission, registers its start
waiter before dispatch, and uses a fresh key for each deliberate submission. Both paths register dispatch
work for draining and shutdown. A lost start RPC reply can fail
an unadmitted launch, preventing its pending job from executing; admitted work
retains authority to record its eventual outcome. Neither case authorizes automatic
execution retry. The run object's existing alarm state prevents duplicate execution,
and a programmatic job also checks its deployment ID before executing user code.

`getLaunch` reads current bookkeeping separately from the immutable receipt. A root
start supplies the run ID; a root completion marks the launch finished regardless
of the pipeline's outcome. Inspect that run for success, failure, or cancellation.
A host failure can close admission before any root start exists.

The public usage and deliberate-new-run rules are in the
[deployment guide](../docs/deploy-cloudflare.md#launch-from-application-code).
