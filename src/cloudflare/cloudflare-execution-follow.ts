import { executionIsActive } from "../hosting/execution-status.js";
import {
  EXECUTION_FOLLOW_CAPABILITY,
  EXECUTION_FOLLOW_MEDIA_TYPE,
  type ExecutionFollowEvent,
} from "../hosting/execution/follow.js";
import type {
  ExecutionFollowPage,
  ReadExecutionFollowPage,
} from "../hosting/execution/follow-store.js";
import { abortableSleep } from "../utilities/abort.js";

const PAGES_PER_RESPONSE = 12;

/** Read bounded pages under backpressure. Reopening a window rechecks Access. */
export function executionFollowResponse(
  id: string,
  after: number,
  initial: ExecutionFollowPage,
  readPage: ReadExecutionFollowPage
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let cursor = after;
  const envelope = { version: EXECUTION_FOLLOW_CAPABILITY.version, executionId: id };
  let pages = 0;
  let hasMore = false;
  let lastStatus: string | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pages > 0 && !hasMore) await abortableSleep(1500, abort.signal, "Follow execution");
        const page = pages++ === 0 ? initial : await readPage(id, cursor);
        if (abort.signal.aborted) return;
        if (!page) throw new Error("Execution disappeared during observation.");
        const { status } = page;
        const frames: ExecutionFollowEvent[] = [];
        const serialized = JSON.stringify(status);
        if (serialized !== lastStatus)
          frames.push({
            ...envelope,
            cursor,
            type: lastStatus === undefined ? "snapshot" : "status",
            payload: status,
          });
        lastStatus = serialized;
        frames.push(...page.events);
        cursor = page.events.at(-1)?.cursor ?? cursor;
        hasMore = page.hasMore;
        const terminal = !hasMore && !executionIsActive(status);
        const done = terminal || pages >= PAGES_PER_RESPONSE;
        const boundary = { ...envelope, cursor };
        if (terminal) {
          if (page.historyMissing)
            frames.push({ ...boundary, type: "gap", payload: { reason: "history_unavailable" } });
          frames.push({ ...boundary, type: "terminal", payload: status });
        } else if (done) frames.push({ ...boundary, type: "end", payload: {} });
        else if (frames.length === 0) frames.push({ ...boundary, type: "heartbeat", payload: {} });
        controller.enqueue(
          encoder.encode(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n")
        );
        if (done) controller.close();
      },
      cancel() {
        abort.abort();
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(stream, {
    headers: {
      "content-type": EXECUTION_FOLLOW_MEDIA_TYPE,
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
