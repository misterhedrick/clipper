import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every status change must go through transition() so it's validated and audited.
// This fails the build if any other source file writes a `status` column via .set({...}).
const SRC = new URL("../src", import.meta.url).pathname;
const ALLOWED = new Set(["db/transition.ts"]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("status writes", () => {
  it("happen only in transition()", () => {
    const offenders = tsFiles(SRC)
      .filter((file) => !ALLOWED.has(relative(SRC, file)))
      .filter((file) => /\.set\(\s*\{[^}]*\bstatus\s*:/s.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
