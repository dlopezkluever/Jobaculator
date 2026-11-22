ALTER TABLE "application_package" ADD COLUMN "answers" jsonb;--> statement-breakpoint
ALTER TABLE "application_package" ADD COLUMN "answers_input_hash" text;--> statement-breakpoint
ALTER TABLE "application_package" ADD COLUMN "answers_call_id" uuid;