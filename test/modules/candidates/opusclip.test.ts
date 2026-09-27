import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyStage, parseOpusClipList } from "../../../src/modules/candidates/opusclip.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/opusclip-list-clips.json", import.meta.url), "utf8"));

describe("parseOpusClipList", () => {
  it("reads the saved tool result", () => {
    const list = parseOpusClipList(fixture);
    expect(list.stage).toBe("COMPLETE");
    expect(list.clips).toHaveLength(3);
    expect(list.clips[0]).toEqual({
      clipId: "P123.c1",
      projectId: "P123",
      rank: 1,
      title: "The one-shot nobody saw coming",
      description: "Clutch final round",
      hashtags: "#mw4 #cod",
      durationMs: 32000,
      score: 92,
      subScores: { hook: 9, coherence: 8, connection: 10, trend: 7 },
      previewUrl: expect.stringContaining("/c.P123.c1/VIDEO_PREVIEW_"),
      thumbnailUrl: expect.stringContaining("/c.P123.c1/thumbnail.jpg"),
    });
    // The bonus copy is its own clip; pre-screen holds it as a duplicate.
    expect(list.clips[1]).toMatchObject({ clipId: "P123.c2", durationMs: 32000 });
    // No hashtags, sub-scores or thumbnail: left unset, not empty.
    expect(list.clips[2]).toMatchObject({ clipId: "P123.c3", hashtags: undefined, subScores: undefined, thumbnailUrl: undefined });
  });

  it("unwraps the MCP envelope", () => {
    const envelope = { content: [{ type: "text", text: JSON.stringify(fixture) }] };
    expect(parseOpusClipList(envelope).clips).toHaveLength(3);
    expect(() => parseOpusClipList({ content: [{ type: "text", text: "nope" }] })).toThrow(/isn't JSON/);
  });

  it("fails loudly instead of guessing", () => {
    expect(() => parseOpusClipList({ stage: "x" })).toThrow(/clips array/);
    expect(() => parseOpusClipList([{ clip_id: "a" }])).toThrow(/clips array/);
    expect(() => parseOpusClipList({ clips: [{ title: "no id" }] })).toThrow(/clip 0: clip_id/);
    expect(() => parseOpusClipList({ clips: [{ id: "a" }] })).toThrow(/clip 0: clip_id/);
    expect(() => parseOpusClipList({ clips: [{ clip_id: "a", duration_sec: "long" }] })).toThrow(/clip 0: duration_sec/);
    expect(() => parseOpusClipList("clips")).toThrow();
  });

  it("returns an empty list for a project still processing", () => {
    expect(parseOpusClipList({ stage: "PROCESSING", clips: [] })).toEqual({ stage: "PROCESSING", clips: [] });
  });
});

describe("classifyStage", () => {
  it("classifies by keyword, treating the unknown as in progress", () => {
    expect(classifyStage("COMPLETE", 3)).toBe("done");
    expect(classifyStage("completed", 0)).toBe("done");
    expect(classifyStage("FAILED", 0)).toBe("failed");
    expect(classifyStage("error_download", 2)).toBe("failed");
    expect(classifyStage("CURATING", 0)).toBe("in_progress");
    expect(classifyStage("CURATING", 2)).toBe("in_progress");
    expect(classifyStage(undefined, 2)).toBe("done");
    expect(classifyStage(undefined, 0)).toBe("in_progress");
  });
});
