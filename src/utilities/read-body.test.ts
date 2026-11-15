import { expect, it, vi } from "vitest";
import { BodyLimitError, readBoundedBody } from "./read-body.js";

it("bounds fragmented input and owns bytes from reused chunks without charging empty reads", async () => {
  const shared = new Uint8Array(1);
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index === 4096) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array());
        shared[0] = index++ % 256;
        controller.enqueue(shared);
      },
    },
    { highWaterMark: 0 }
  );
  expect(await readBoundedBody(body, 4096)).toEqual(
    Uint8Array.from({ length: 4096 }, (_, index) => index % 256)
  );
  expect(body.locked).toBe(false);
});

it("rejects the first byte beyond a fragmented body's limit and releases its reader", async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    },
    { highWaterMark: 0 }
  );
  await expect(readBoundedBody(body, 3)).rejects.toBeInstanceOf(BodyLimitError);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it("cancels a pending read on abort without awaiting an uncooperative source", async () => {
  const abort = new AbortController();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ cancel });
  const checked = expect(readBoundedBody(body, 10, abort.signal)).rejects.toThrow();
  abort.abort();
  await checked;
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
