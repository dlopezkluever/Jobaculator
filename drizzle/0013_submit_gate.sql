CREATE TABLE "intervention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"browser_run_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "submit_intent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"browser_run_id" uuid NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"revision" jsonb NOT NULL,
	"confirmation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "submit_intent_browser_run_id_unique" UNIQUE("browser_run_id")
);
--> statement-breakpoint
CREATE TABLE "launch_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_run" ADD COLUMN "intent_id" uuid;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "canary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_browser_run_id_browser_run_id_fk" FOREIGN KEY ("browser_run_id") REFERENCES "public"."browser_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_application_id_user_id_application_id_user_id_fk" FOREIGN KEY ("application_id","user_id") REFERENCES "public"."application"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submit_intent" ADD CONSTRAINT "submit_intent_browser_run_id_browser_run_id_fk" FOREIGN KEY ("browser_run_id") REFERENCES "public"."browser_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submit_intent" ADD CONSTRAINT "submit_intent_application_id_user_id_application_id_user_id_fk" FOREIGN KEY ("application_id","user_id") REFERENCES "public"."application"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intervention_user_idx" ON "intervention" USING btree ("user_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "submit_intent_open_idx" ON "submit_intent" USING btree ("application_id") WHERE "submit_intent"."status" in ('OPEN', 'UNKNOWN');--> statement-breakpoint
CREATE INDEX "submit_intent_user_idx" ON "submit_intent" USING btree ("user_id","status","resolved_at");--> statement-breakpoint
CREATE INDEX "launch_step_step_idx" ON "launch_step" USING btree ("step","recorded_at");--> statement-breakpoint
ALTER TABLE "browser_run" ADD CONSTRAINT "browser_run_intent_id_unique" UNIQUE("intent_id");