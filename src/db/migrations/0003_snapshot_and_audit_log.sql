CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"details" jsonb,
	CONSTRAINT "audit_log_entity_type_check" CHECK (entity_type in ('campaign', 'source_job', 'candidate_clip', 'footage_source', 'credits'))
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "cr_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "cr_snapshot_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");