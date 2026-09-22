import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ quiet: true });

const nonEmpty = z.string().trim().min(1);

const configSchema = z.object({
  DATABASE_URL: z.url(),
  OPUSCLIP_API_KEY: nonEmpty,
  GOOGLE_API_KEY: nonEmpty,
  ANTHROPIC_API_KEY: nonEmpty,
  R2_ACCOUNT_ID: nonEmpty,
  R2_ACCESS_KEY_ID: nonEmpty,
  R2_SECRET_ACCESS_KEY: nonEmpty,
  R2_BUCKET_NAME: nonEmpty,
  // v1 notification channel is a webhook (Slack incoming webhook or similar).
  NOTIFY_WEBHOOK_URL: z.url(),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Validates every required env var up front so the process fails at boot,
 * not at the first request that happens to need a missing secret.
 * Error messages name the variable but never echo its value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return result.data;
}
