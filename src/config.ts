import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ quiet: true });

const nonEmpty = z.string().trim().min(1);

// Each entry point loads only the sections it uses, so e.g. a read-only CLI
// command doesn't need R2 credentials. The app makes no LLM or OpusClip calls
// (the operator session does), so neither API key appears here.
const sections = {
  db: z.object({
    DATABASE_URL: z.url(),
  }),
  server: z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    // Shared secret for the review web app (v1). Long enough not to be guessable.
    REVIEWER_TOKEN: z.string().min(24, "must be at least 24 characters"),
  }),
  credits: z.object({
    // Max OpusClip credits `clipper source reserve` may hold per UTC day (~1 credit per source minute).
    OPUSCLIP_DAILY_CREDIT_BUDGET: z.coerce.number().int().positive(),
  }),
  r2: z.object({
    R2_ACCOUNT_ID: nonEmpty,
    R2_ACCESS_KEY_ID: nonEmpty,
    R2_SECRET_ACCESS_KEY: nonEmpty,
    R2_BUCKET_NAME: nonEmpty,
  }),
  notify: z.object({
    // v1 notification channel is a webhook (Slack incoming webhook or similar).
    NOTIFY_WEBHOOK_URL: z.url(),
    // Optional: the review web app's public URL, linked from notifications.
    REVIEW_URL: z.url().optional(),
  }),
} as const;

type Sections = typeof sections;
export type ConfigSection = keyof Sections;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
export type Config<K extends ConfigSection> = UnionToIntersection<z.infer<Sections[K]>>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Validates the env vars for the given sections up front, so a process fails at
 * boot naming every missing or invalid variable, not at the first request that
 * needs one. Error messages name the variable but never echo its value.
 */
export function loadConfig<K extends ConfigSection>(
  keys: readonly K[],
  env: NodeJS.ProcessEnv = process.env,
): Config<K> {
  const shape = Object.assign({}, ...keys.map((k) => sections[k].shape));
  const result = z.object(shape).safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return result.data as Config<K>;
}
