import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Loading the undici package replaces Node's global dispatcher, after which the
// built-in fetch hands back gzip bodies undecoded (a Drive folder listing came
// back as binary). The CLI and the server must not load it at startup.
describe("global fetch", () => {
  it("loading the CLI and the web app leaves Node's dispatcher alone", () => {
    const script = `
      await import("./src/cli/run.ts");
      await import("./src/cli/remote.ts");
      await import("./src/app.ts");
      process.stdout.write(String(globalThis[Symbol.for("undici.globalDispatcher.1")] === undefined));
    `;
    const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8" });
    expect(out).toBe("true");
  });
});
