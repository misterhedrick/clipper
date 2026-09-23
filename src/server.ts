import { ConfigError, loadConfig, type Config } from "./config.js";
import { createDb } from "./db/client.js";
import { buildApp } from "./app.js";
import { r2Store } from "./modules/packaging/r2.js";

let config: Config<"db" | "server">;
try {
  config = loadConfig(["db", "server"]);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { db, pool } = createDb(config.DATABASE_URL);
// R2 is optional for the web app: without it, packaged bundles just aren't linked for download.
let bundles: ReturnType<typeof r2Store> | undefined;
try {
  bundles = r2Store(loadConfig(["r2"]));
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
}
const app = buildApp({ db, reviewerToken: config.REVIEWER_TOKEN, bundles, trustProxyHops: config.TRUST_PROXY_HOPS, operatorToken: config.OPERATOR_TOKEN });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
