import { run } from "./run.js";
import { remoteTarget, runRemote } from "./remote.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// With CLIPPER_OPERATOR_TOKEN set (the operator's cloud environment, which can't
// open Postgres connections), commands run on the review app over HTTPS instead.
const remote = remoteTarget(process.env);
const argv = process.argv.slice(2);
// `candidate frames` writes images for the operator to look at, so it always runs
// here; in remote mode only its candidate lookup goes to the review app.
const localInRemote = remote && argv[0] === "candidate" && argv[1] === "frames";
const { exitCode, output } = !remote
  ? await run(argv)
  : localInRemote
    ? await run(argv, { showCandidate: (id) => runRemote(["candidate", "show", id], { ...remote, readStdin }) })
    : await runRemote(argv, { ...remote, readStdin });
const text = JSON.stringify(output, null, 2);
// A blocking guard result is shown to Claude via stderr by the hook runner.
if (exitCode === 2) console.error(text);
else console.log(text);
process.exitCode = exitCode;
