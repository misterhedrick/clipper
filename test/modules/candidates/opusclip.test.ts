import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyStage, parseOpusClipList } from "../../../src/modules/candidates/opusclip.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/opusclip-list-clips.json", import.meta.url), "utf8"));

describe("parseOpusClipList", () => {
  it("reads the saved tool result", () => {
    const list = parseOpusClipList(fixture);
    expect(list.stage).toBe("COMPLETE");
    expect(list.projectId).toBe("P123");
    expect(list.clips).toHaveLength(3);
    expect(list.clips[0]).toEqual({
      clipId: "P123.c1",
      projectId: undefined,
      rank: 1,
      title: "The one-shot nobody saw coming",
      description: "Clutch final round",
      hashtags: "#mw4 #cod",
      durationMs: 32000,
      score: 92,
      subScores: { hook: 9.1, coherence: 8.4, connection: 7.9, trend: 6.5 },
      previewUrl: "https://cdn.opus.pro/P123/c1/preview.mp4",
      thumbnailUrl: "https://cdn.opus.pro/P123/c1/thumb.jpg",
      aspect: "9:16",
      width: undefined,
      height: undefined,
    });
  });

  it("accepts camelCase and REST-style keys, bare arrays and the MCP envelope", () => {
    const camel = [{ clipId: "a", durationSec: 20, previewUrl: "p", aspectRatio: "portrait", hook: 8, trend: "5.5" }];
    expect(parseOpusClipList(camel).clips[0]).toMatchObject({ clipId: "a", durationMs: 20000, previewUrl: "p", aspect: "portrait", subScores: { hook: 8, trend: 5.5 } });

    const rest = { data: [{ id: "P.x", projectId: "P", durationMs: 31000, uriForPreview: "u" }] };
    expect(parseOpusClipList(rest)).toMatchObject({ clips: [{ clipId: "P.x", projectId: "P", durationMs: 31000, previewUrl: "u" }] });

    const envelope = { content: [{ type: "text", text: JSON.stringify(fixture) }] };
    expect(parseOpusClipList(envelope).clips).toHaveLength(3);
  });

  it("reads a bare `duration` as seconds unless it can only be milliseconds", () => {
    expect(parseOpusClipList([{ id: "a", duration: 42.5 }]).clips[0]!.durationMs).toBe(42500);
    expect(parseOpusClipList([{ id: "a", duration: 42500 }]).clips[0]!.durationMs).toBe(42500);
  });

  it("fails loudly instead of guessing", () => {
    expect(() => parseOpusClipList({ stage: "x" })).toThrow(/no clips array/);
    expect(() => parseOpusClipList([{ title: "no id" }])).toThrow(/clip 0 has no id/);
    expect(() => parseOpusClipList([{ id: "a", duration_ms: "long" }])).toThrow(/clip 0: duration_ms/);
    expect(() => parseOpusClipList("clips")).toThrow();
  });

  it("returns an empty list for a project still processing", () => {
    expect(parseOpusClipList({ stage: "PROCESSING", clips: [] })).toEqual({ stage: "PROCESSING", projectId: undefined, clips: [] });
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
