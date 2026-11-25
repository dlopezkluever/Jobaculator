ALTER TABLE "application" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "retry_after" timestamp with time zone;