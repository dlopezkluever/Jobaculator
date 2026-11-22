CREATE TABLE "application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"driving_hunt_id" uuid NOT NULL,
	"driving_match_id" uuid NOT NULL,
	"status" text DEFAULT 'PREPARING' NOT NULL,
	"fit" integer NOT NULL,
	"review" boolean NOT NULL,
	"evaluation" jsonb NOT NULL,
	"preparation_dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "application_user_opportunity_key" UNIQUE("user_id","opportunity_id")
);
--> statement-breakpoint
CREATE TABLE "hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_driving_hunt_id_hunt_id_fk" FOREIGN KEY ("driving_hunt_id") REFERENCES "public"."hunt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_driving_match_id_match_id_fk" FOREIGN KEY ("driving_match_id") REFERENCES "public"."match"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_opportunity_id_user_id_opportunity_id_user_id_fk" FOREIGN KEY ("opportunity_id","user_id") REFERENCES "public"."opportunity"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold" ADD CONSTRAINT "hold_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_status_idx" ON "application" USING btree ("status","preparation_dispatched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hold_active_idx" ON "hold" USING btree ("user_id","scope") WHERE "hold"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "hold_user_idx" ON "hold" USING btree ("user_id","raised_at");