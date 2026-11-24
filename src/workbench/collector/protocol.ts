import type { CollectorRunJob } from "../../hosting/collector/run.js";
import {
  wireDiscriminatedUnion,
  wireEnum,
  wireLiteral,
  wireObject,
  wireString,
  type InferWireSchema,
} from "../../tracing/wire-schema.js";

/** Private host-to-worker IPC. The trusted supervisor selects code; job values never select modules. */
export interface CollectorWorkerStart {
  readonly type: "start";
  readonly job: CollectorRunJob;
  readonly baseUrl: string;
  readonly token: string;
  readonly deploymentId: string;
  readonly module: string;
  readonly exportName?: string;
}
export type CollectorWorkerRequest = CollectorWorkerStart | { readonly type: "cancel" };
const resultSchema = wireObject(
  {
    status: wireEnum(["refused", "unconfirmed", "history-confirmed"]),
  },
  { strict: true }
);
export const collectorWorkerResponseSchema = wireDiscriminatedUnion("type", {
  claimed: wireObject(
    { type: wireLiteral("claimed"), workerId: wireString({ maxLength: 256 }) },
    { strict: true }
  ),
  done: wireObject({ type: wireLiteral("done"), result: resultSchema }, { strict: true }),
});
export type CollectorWorkerResponse = InferWireSchema<typeof collectorWorkerResponseSchema>;
