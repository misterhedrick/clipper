import { config } from "./config.js";
import { buildServer } from "./server.js";

async function main() {
  const app = buildServer();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("clipper-api failed to start:", err);
  process.exit(1);
});
