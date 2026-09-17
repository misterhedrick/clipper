import { config } from "./config.js";
import { getBoss } from "./queue/index.js";
import { registerScanSchedules } from "./queue/scheduler.js";
import { registerItemWorkers } from "./queue/workers.js";

async function main() {
  const boss = await getBoss();
  await registerScanSchedules(boss);
  registerItemWorkers(boss);
  // eslint-disable-next-line no-console
  console.log(`clipper-worker started (port config unused here; PORT=${config.PORT} is for clipper-api)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("clipper-worker failed to start:", err);
  process.exit(1);
});
