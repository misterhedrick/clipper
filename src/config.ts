import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  OPUSCLIP_API_KEY: z.string().min(1, "OPUSCLIP_API_KEY is required"),
  GOOGLE_API_KEY: z.string().min(1, "GOOGLE_API_KEY is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  R2_ACCOUNT_ID: z.string().min(1, "R2_ACCOUNT_ID is required"),
  R2_ACCESS_KEY_ID: z.string().min(1, "R2_ACCESS_KEY_ID is required"),
  R2_SECRET_ACCESS_KEY: z.string().min(1, "R2_SECRET_ACCESS_KEY is required"),
  R2_BUCKET_NAME: z.string().min(1, "R2_BUCKET_NAME is required"),
  NOTIFY_WEBHOOK_URL: z.string().min(1, "NOTIFY_WEBHOOK_URL is required"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  OPUSCLIP_WEBHOOK_SECRET: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Fails fast at boot, not at first use — per BUILD_PLAN.md task 0.
 * Import this module once at the top of each entrypoint (apiMain.ts, workerMain.ts).
 */
function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
