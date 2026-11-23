CREATE TABLE "browser_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checkpoint" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "submission_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'DRY_RUN' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "requested_mode" text;--> statement-breakpoint
ALTER TABLE "hunt" ADD COLUMN "submission_mode" text;--> statement-breakpoint
ALTER TABLE "browser_run" ADD CONSTRAINT "browser_run_application_id_user_id_application_id_user_id_fk" FOREIGN KEY ("application_id","user_id") REFERENCES "public"."application"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_settings" ADD CONSTRAINT "submission_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_run_active_idx" ON "browser_run" USING btree ("application_id") WHERE "browser_run"."status" in ('QUEUED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "browser_run_application_idx" ON "browser_run" USING btree ("user_id","application_id","created_at");--> statement-breakpoint
CREATE INDEX "browser_run_status_idx" ON "browser_run" USING btree ("status");