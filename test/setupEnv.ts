// Ensures src/config.ts's env validation doesn't crash test runs that
// import a module which transitively touches config.ts (e.g. db/pool.ts,
// or any module instantiating an API client at import time). Real
// credentials are never needed for unit tests — only integration tests
// (run manually, per BUILD_PLAN.md) hit real external services.
const defaults: Record<string, string> = {
  DATABASE_URL: "postgres://clipper:clipper_dev@localhost:5432/clipper_dev",
  OPUSCLIP_API_KEY: "test-opusclip-key",
  GOOGLE_API_KEY: "test-google-key",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  R2_ACCOUNT_ID: "test-r2-account",
  R2_ACCESS_KEY_ID: "test-r2-access-key",
  R2_SECRET_ACCESS_KEY: "test-r2-secret",
  R2_BUCKET_NAME: "test-bucket",
  NOTIFY_WEBHOOK_URL: "https://example.com/webhook",
  PUBLIC_BASE_URL: "http://localhost:3000",
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
