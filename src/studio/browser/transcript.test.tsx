import { renderToString } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { transcriptRecord } from "../../tracing/agent-transcript.test-support.js";
import { TranscriptRecords } from "./components/transcript.js";
import { createStudioApi } from "./transport.js";

describe("Studio transcript display and transport", () => {
  it("escapes content and renders omissions, partial capture and later-turn links", () => {
    const { event: _, ...base } = transcriptRecord(2);
    const html = renderToString(
      <TranscriptRecords
        page={{
          runId: "run",
          status: "partial",
          records: [
            {
              ...transcriptRecord(
                1,
                { kind: "assistant", text: "<script>alert('private')</script>" },
                "run"
              ),
              turn: 17,
            },
            { ...base, runId: "run", omitted: "outcome", reason: "record-limit" },
          ],
        }}
        turnRuns={{ 17: "turn-17" }}
        onOpenRun={() => {}}
      />
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script");
    expect(html).toContain("outcome omitted");
    expect(html).toContain("record-limit");
    expect(html).toContain("partial");
    expect(html).toContain("Turn 17");
    expect(html.match(/Open turn/g)).toHaveLength(1);
  });

  it("checks transcript identities, cursors and records at the transport boundary", async () => {
    const page = {
      runId: "run",
      status: "partial",
      records: [transcriptRecord(1, { kind: "assistant", text: "text" }, "run")],
    };
    const payload = { transcript: page, turnRuns: { 1: "turn-1" } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
    const api = createStudioApi(fetcher, "/admin");
    expect(await api.loadTranscript!("run")).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "/admin/api/runs/run/transcript?afterSequence=0",
      expect.objectContaining({ cache: "no-store" })
    );
    await expect(api.loadTranscript!("run", 1)).rejects.toThrow("invalid response");
    fetcher.mockResolvedValue(
      Response.json({ ...payload, transcript: { ...page, runId: "other" } })
    );
    await expect(api.loadTranscript!("run")).rejects.toThrow("invalid response");
    fetcher.mockResolvedValue(
      Response.json({
        ...payload,
        transcript: { ...page, records: [{ ...page.records[0], version: 7 }] },
      })
    );
    await expect(api.loadTranscript!("run")).rejects.toThrow("invalid response");
  });

  it("notifies and locks out access after a transcript authorization denial", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 403 }));
    const api = createStudioApi(fetcher);
    const denied = vi.fn();
    api.subscribeAccessDenied!(denied);
    await expect(api.loadTranscript!("run")).rejects.toThrow("Access denied");
    await expect(api.loadRunDetail("run")).rejects.toThrow("Access denied");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(denied).toHaveBeenCalledWith(403);
  });
});
