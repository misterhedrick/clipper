import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every status change on a campaign, source job or candidate clip must go through
// transition() so it's validated and audited. This fails the build if any other
// source file writes those tables' `status` via .update(<table>).set({...status...}).
// (Other tables' own status columns, e.g. credit_ledger's open/consumed/released, aren't entity statuses.)
const ENTITY_STATUS_WRITE = /\.update\(\s*(campaigns|sourceJobs|candidateClips)\s*\)\s*\.set\(\s*\{[^}]*\bstatus\s*:/s;
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
      .filter((file) => ENTITY_STATUS_WRITE.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("never name the active status in CLI code (campaigns reach active only via a reviewer)", () => {
    const cliDir = join(SRC, "cli");
    const offenders = tsFiles(cliDir)
      .filter((file) => /["'`]active["'`]/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
