DROP INDEX "source_jobs_campaign_drive_file_uidx";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "drive_folder_url";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "drive_folder_id";--> statement-breakpoint
ALTER TABLE "source_jobs" DROP COLUMN "drive_file_id";--> statement-breakpoint
ALTER TABLE "source_jobs" DROP COLUMN "drive_file_name";