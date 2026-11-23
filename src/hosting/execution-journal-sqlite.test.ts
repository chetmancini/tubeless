import { expect, it } from "vitest";
import { createFakeDurableStorage } from "../cloudflare/cloudflare-storage.test-support.js";
import { SqliteExecutionJournal } from "./execution-journal-sqlite.js";

it("persists lossless bindings and void completions while fencing the previous owner", async () => {
  const storage = createFakeDurableStorage();
  const journal = new SqliteExecutionJournal(storage);
  expect(journal.advance(1000)).toEqual({ generation: 1, deadlineAtMs: 1000 });
  const first = journal.open("launch", 1);
  const input = { optional: undefined, zero: -0 };
  await first.bind(["root"], input);
  expect(await first.begin(["root", "effect"], input, "effect")).toEqual({ status: "new" });
  await first.complete(["root", "effect"], undefined);

  const restarted = new SqliteExecutionJournal(storage);
  expect(restarted.advance(2000)).toEqual({ generation: 2, deadlineAtMs: 1000 });
  await expect(first.complete(["root", "effect"], undefined)).rejects.toThrow("stale");
  const current = restarted.open("launch", 2);
  await expect(current.bind(["root"], { zero: -0 })).rejects.toThrow("binding differs");
  await expect(current.bind(["root"], { optional: undefined, zero: 0 })).rejects.toThrow(
    "binding differs"
  );
  await current.bind(["root"], input);
  expect(await current.begin(["root", "effect"], input, "effect")).toStrictEqual({
    status: "completed",
    value: undefined,
  });
  await expect(current.complete(["root", "effect"], 1)).rejects.toThrow(
    "matching intent and result"
  );
});
