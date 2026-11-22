CREATE TABLE "match" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"hunt_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"fit" integer,
	"decision" text,
	"reason" text,
	"dimensions" jsonb,
	"evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_hunt_id_opportunity_id_unique" UNIQUE("hunt_id","opportunity_id")
);
--> statement-breakpoint
CREATE TABLE "opportunity_extraction" (
	"opportunity_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"call_id" uuid NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_hunt_id_hunt_id_fk" FOREIGN KEY ("hunt_id") REFERENCES "public"."hunt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_opportunity_id_user_id_opportunity_id_user_id_fk" FOREIGN KEY ("opportunity_id","user_id") REFERENCES "public"."opportunity"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_extraction" ADD CONSTRAINT "opportunity_extraction_opportunity_id_user_id_opportunity_id_user_id_fk" FOREIGN KEY ("opportunity_id","user_id") REFERENCES "public"."opportunity"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_user_opportunity_idx" ON "match" USING btree ("user_id","opportunity_id");