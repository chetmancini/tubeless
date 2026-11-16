import { isDeepStrictEqual } from "node:util";
import { deserialize, serialize } from "node:v8";
import type { PipelineExecutionJournal } from "./pipeline.js";

/** Test host with retained bytes independent of adapter/executor instances. Not a production store. */
export function retainedJournal(
  records = new Map<string, Buffer>(),
  key = "job"
): PipelineExecutionJournal {
  const read = (id: string): unknown =>
    records.has(id) ? deserialize(records.get(id)!) : undefined;
  const conflict = () =>
    Object.assign(new Error("Recovery binding changed"), { code: "HOST_CONFLICT" });
  type Receipt = { inputs: unknown; boundary: string; completed: boolean; value?: unknown };
  return {
    key,
    async bind(path, binding) {
      const id = JSON.stringify(["bind", path]);
      if (records.has(id) && !isDeepStrictEqual(read(id), binding)) throw conflict();
      records.set(id, serialize(binding));
    },
    async begin(path, inputs, boundary) {
      const id = JSON.stringify(["step", path]);
      const saved = read(id) as Receipt | undefined;
      if (saved) {
        if (saved.boundary !== boundary || !isDeepStrictEqual(saved.inputs, inputs))
          throw conflict();
        return saved.completed
          ? { status: "completed", value: saved.value }
          : { status: "incomplete" };
      }
      records.set(id, serialize({ inputs, boundary, completed: false }));
      return { status: "new" };
    },
    async complete(path, value) {
      const id = JSON.stringify(["step", path]);
      const saved = read(id) as Receipt | undefined;
      if (!saved || (saved.completed && !isDeepStrictEqual(saved.value, value))) throw conflict();
      records.set(id, serialize({ ...saved, completed: true, value }));
    },
  };
}
