import { run } from "./run.js";
import { runRemote } from "./remote.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// With CLIPPER_REMOTE_URL set (the operator's cloud environment, which can't open
// Postgres connections), commands run on the review app over HTTPS instead.
const remoteUrl = process.env.CLIPPER_REMOTE_URL;
const argv = process.argv.slice(2);
const { exitCode, output } = remoteUrl
  ? await runRemote(argv, { url: remoteUrl, token: process.env.CLIPPER_OPERATOR_TOKEN ?? "", readStdin })
  : await run(argv);
const text = JSON.stringify(output, null, 2);
// A blocking guard result is shown to Claude via stderr by the hook runner.
if (exitCode === 2) console.error(text);
else console.log(text);
process.exitCode = exitCode;
