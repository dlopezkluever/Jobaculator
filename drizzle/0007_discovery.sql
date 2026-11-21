CREATE TABLE "opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"dedup_key" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"employer_name" text NOT NULL,
	"title" text NOT NULL,
	"title_normalized" text NOT NULL,
	"location_text" text,
	"workplace_type" text,
	"employment_type" text,
	"salary" jsonb,
	"canonical_url" text NOT NULL,
	"description_markdown" text,
	"raw_blob" text,
	"posted_at" timestamp with time zone,
	"posted_at_source" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "opportunity_user_id_dedup_key_unique" UNIQUE("user_id","dedup_key")
);
--> statement-breakpoint
CREATE TABLE "opportunity_alias" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"opportunity_id" uuid NOT NULL,
	CONSTRAINT "opportunity_alias_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "sighting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"native_id" text NOT NULL,
	"url" text NOT NULL,
	"apply_url" text NOT NULL,
	"title" text NOT NULL,
	"location_text" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"content_hash" text NOT NULL,
	"field_hashes" jsonb NOT NULL,
	"raw_blob" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"missed_listings" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "sighting_board_id_native_id_unique" UNIQUE("board_id","native_id")
);
--> statement-breakpoint
CREATE TABLE "watched_board" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"token" text NOT NULL,
	"employer_name" text NOT NULL,
	"origin" text NOT NULL,
	"next_poll_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"last_listed_at" timestamp with time zone,
	"last_failure" text,
	"last_failure_detail" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"not_found_count" integer DEFAULT 0 NOT NULL,
	"not_found_since" timestamp with time zone,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watched_board_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "watched_board_user_id_source_token_unique" UNIQUE("user_id","source","token")
);
--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_raw_blob_blob_hash_fk" FOREIGN KEY ("raw_blob") REFERENCES "public"."blob"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_alias" ADD CONSTRAINT "opportunity_alias_opportunity_id_user_id_opportunity_id_user_id_fk" FOREIGN KEY ("opportunity_id","user_id") REFERENCES "public"."opportunity"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sighting" ADD CONSTRAINT "sighting_raw_blob_blob_hash_fk" FOREIGN KEY ("raw_blob") REFERENCES "public"."blob"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sighting" ADD CONSTRAINT "sighting_opportunity_id_user_id_opportunity_id_user_id_fk" FOREIGN KEY ("opportunity_id","user_id") REFERENCES "public"."opportunity"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sighting" ADD CONSTRAINT "sighting_board_id_user_id_watched_board_id_user_id_fk" FOREIGN KEY ("board_id","user_id") REFERENCES "public"."watched_board"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watched_board" ADD CONSTRAINT "watched_board_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opportunity_user_seen_idx" ON "opportunity" USING btree ("user_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "sighting_opportunity_idx" ON "sighting" USING btree ("opportunity_id");