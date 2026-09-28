ALTER TABLE "posts" ADD COLUMN "status" text DEFAULT 'posted' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "post_account_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "account_handle" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "publish_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "post_params" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "approval_url" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "opusclip_schedule_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "posts_account_publish_idx" ON "posts" USING btree ("post_account_id","publish_at");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_status_check" CHECK (status in ('planned', 'requested', 'scheduled', 'posted', 'failed', 'cancelled'));