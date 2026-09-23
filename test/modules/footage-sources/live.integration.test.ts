import { describe, expect, it } from "vitest";
import { listFootageUrl } from "../../../src/modules/footage-sources/index.js";

// Real campaign folders from the survey (docs/CAMPAIGN_SURVEY.md). Run with RUN_NETWORK_TESTS=1.
describe.skipIf(!process.env.RUN_NETWORK_TESTS)("footage listing against live sources", () => {
  it("Nilo (#46): purpose-named subfolders, videos found inside them", { timeout: 60_000 }, async () => {
    const l = await listFootageUrl("https://drive.google.com/drive/folders/1_zjm2aXLeNanscYRx5IJSIN1sgrukPBH?usp=sharing");
    // Folder names themselves can contain " / ", so match whole paths.
    expect(l.folders.map((f) => f.path)).toEqual(
      expect.arrayContaining(["Un-Edited Clips", "Static Assets / Still Image", "Memes Only [ADD SOME CTA]"]),
    );
    expect(l.entries.some((e) => e.path.startsWith("Un-Edited Clips") && e.isVideo)).toBe(true);
    expect(l.entries.some((e) => !e.isVideo)).toBe(true);
  });

  it("Charlie Berens (#23): exactly the two full specials", { timeout: 30_000 }, async () => {
    const l = await listFootageUrl("https://drive.google.com/drive/folders/18HJBRU4qhS6m5h52Yy38YOJmdhecWeTH?dmr=1");
    expect(l.folders).toEqual([]);
    expect(l.entries.map((e) => e.isVideo)).toEqual([true, true]);
    expect(l.entries.every((e) => /FULL SPECIAL/i.test(e.name) && e.sourceKey?.startsWith("gdrive:"))).toBe(true);
  });

  it("a YouTube @handle resolves to its own channel's recent uploads", { timeout: 30_000 }, async () => {
    const l = await listFootageUrl("https://www.youtube.com/@MacMula");
    expect(l.entries.length).toBeGreaterThan(0);
    expect(l.entries.every((e) => e.sourceKey?.startsWith("youtube:"))).toBe(true);
  });
});
