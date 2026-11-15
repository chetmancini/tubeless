// Preserve the published replay report while keeping validated nested calls in toolLog.
export function projectEvaluationTranscript(records) {
  const decisions = records.filter(
    (record) => "event" in record && record.event.kind === "decision"
  );
  const key = (record, id, tool) => JSON.stringify([record.runId, record.turn, id, tool]);
  const proposed = new Set();
  const calls = [];
  for (const record of decisions) {
    const decision = record.event.decision;
    if (decision?.kind !== "continue" || !Array.isArray(decision.calls)) continue;
    for (const call of decision.calls) {
      if (!call || typeof call.id !== "string" || typeof call.tool !== "string") continue;
      proposed.add(key(record, call.id, call.tool));
      calls.push(call);
    }
  }
  const accepted = new Map();
  const completed = new Map();
  const toolLog = [];
  for (const record of records) {
    if (!("event" in record)) continue;
    const event = record.event;
    if (event.kind === "call") accepted.set(key(record, event.id, event.tool), event);
    if (event.kind !== "outcome") continue;
    const outcome = event.outcome;
    const identity = key(record, outcome.id, outcome.tool);
    if (proposed.has(identity)) completed.set(identity, { record, outcome });
    const call = accepted.get(identity);
    if (call && call.tool !== "codemode")
      toolLog.push({
        tool: call.tool,
        input: call.input,
        ok: outcome.ok,
        ...(outcome.ok ? { value: outcome.value } : { code: outcome.error.code }),
      });
  }
  // The harness presents a batch in decision order even when tools finish out of order.
  const ordered = [...proposed].flatMap((identity) =>
    completed.has(identity) ? [completed.get(identity)] : []
  );
  return {
    calls,
    outcomes: ordered.map(({ outcome }) => outcome),
    turns: decisions.map((record) => ({
      decision: record.event.decision,
      outcomes: ordered
        .filter(
          (entry) => entry.record.runId === record.runId && entry.record.turn === record.turn - 1
        )
        .map(({ outcome }) => outcome),
    })),
    compactions: records.filter((record) => "event" in record && record.event.kind === "compaction")
      .length,
    toolLog,
  };
}
