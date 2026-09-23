import { run } from "./run.js";

const { exitCode, output } = await run(process.argv.slice(2));
const text = JSON.stringify(output, null, 2);
// A blocking guard result is shown to Claude via stderr by the hook runner.
if (exitCode === 2) console.error(text);
else console.log(text);
process.exitCode = exitCode;
