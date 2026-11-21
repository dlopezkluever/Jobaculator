CREATE TABLE "candidate_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "candidate_entry_id_user_key" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "candidate_fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" uuid,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"provenance" text NOT NULL,
	"authoritative" boolean NOT NULL,
	"verified" boolean NOT NULL,
	"sources" jsonb NOT NULL,
	"conflict_group" uuid,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "candidate_fact_id_user_key" UNIQUE("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "candidate_entry" ADD CONSTRAINT "candidate_entry_user_id_candidate_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."candidate"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_entry" ADD CONSTRAINT "candidate_entry_parent_id_user_id_candidate_entry_id_user_id_fk" FOREIGN KEY ("parent_id","user_id") REFERENCES "public"."candidate_entry"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact" ADD CONSTRAINT "candidate_fact_user_id_candidate_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."candidate"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact" ADD CONSTRAINT "candidate_fact_entry_id_user_id_candidate_entry_id_user_id_fk" FOREIGN KEY ("entry_id","user_id") REFERENCES "public"."candidate_entry"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_fact" ADD CONSTRAINT "candidate_fact_superseded_by_user_id_candidate_fact_id_user_id_fk" FOREIGN KEY ("superseded_by","user_id") REFERENCES "public"."candidate_fact"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidate_entry_user_idx" ON "candidate_entry" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "candidate_fact_slot_idx" ON "candidate_fact" USING btree ("user_id","entry_id","kind");