CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_job_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"credits_reserved" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "credit_ledger_status_check" CHECK (status in ('open', 'consumed', 'released')),
	CONSTRAINT "credit_ledger_credits_check" CHECK (credits_reserved > 0),
	CONSTRAINT "credit_ledger_closed_check" CHECK ((status = 'open') = (closed_at is null))
);
--> statement-breakpoint
CREATE TABLE "footage_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"label" text,
	"added_by" text NOT NULL,
	"reason" text NOT NULL,
	"last_listed_at" timestamp with time zone,
	CONSTRAINT "footage_sources_kind_check" CHECK (kind in ('gdrive_folder', 'gdrive_file', 'youtube_channel', 'youtube_video', 's3_mp4', 'dropbox', 'frameio', 'loom', 'vimeo', 'twitch', 'opus_upload'))
);
--> statement-breakpoint
CREATE TABLE "opus_usage_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used" integer NOT NULL,
	"monthly_limit" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_jobs" DROP CONSTRAINT "source_jobs_status_check";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "campaign_type" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "campaign_type_reason" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "max_daily_credits" integer;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "opusclip_score" numeric;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "opusclip_sub_scores" jsonb;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "prescreen_verdict" text;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "prescreen_notes" text;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "prescreened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "review_notes" text;--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD COLUMN "edit_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "footage_source_id" uuid;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "source_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "source_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "source_name" text;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "source_path" text;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "decision" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "decision_reason" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "decided_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "submit_params" jsonb;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD COLUMN "opusclip_stage" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_source_job_id_source_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."source_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "footage_sources" ADD CONSTRAINT "footage_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_one_open_per_job_uidx" ON "credit_ledger" USING btree ("source_job_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "credit_ledger_reserved_at_idx" ON "credit_ledger" USING btree ("reserved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "footage_sources_campaign_url_uidx" ON "footage_sources" USING btree ("campaign_id","url");--> statement-breakpoint
ALTER TABLE "source_jobs" ADD CONSTRAINT "source_jobs_footage_source_id_footage_sources_id_fk" FOREIGN KEY ("footage_source_id") REFERENCES "public"."footage_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_jobs_campaign_source_key_uidx" ON "source_jobs" USING btree ("campaign_id","source_key");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_campaign_type_check" CHECK (campaign_type is null or campaign_type in ('lf', 'ugc', 'music', 'slideshow', 'unclear'));--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_max_daily_credits_check" CHECK (max_daily_credits is null or max_daily_credits > 0);--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD CONSTRAINT "candidate_clips_prescreen_verdict_check" CHECK (prescreen_verdict is null or prescreen_verdict in ('recommend', 'hold', 'reject'));--> statement-breakpoint
ALTER TABLE "source_jobs" ADD CONSTRAINT "source_jobs_kind_check" CHECK (source_kind in ('gdrive_folder', 'gdrive_file', 'youtube_channel', 'youtube_video', 's3_mp4', 'dropbox', 'frameio', 'loom', 'vimeo', 'twitch', 'opus_upload'));--> statement-breakpoint
ALTER TABLE "source_jobs" ADD CONSTRAINT "source_jobs_decision_check" CHECK (decision in ('selected', 'skipped'));--> statement-breakpoint
ALTER TABLE "source_jobs" ADD CONSTRAINT "source_jobs_skip_status_check" CHECK ((decision = 'skipped') = (status = 'skipped'));--> statement-breakpoint
ALTER TABLE "source_jobs" ADD CONSTRAINT "source_jobs_status_check" CHECK (status in ('detected', 'skipped', 'validating', 'validation_failed', 'queued', 'submitting', 'submit_failed', 'project_created', 'processing', 'candidates_ready', 'needs_attention', 'completed'));