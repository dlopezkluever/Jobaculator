CREATE TABLE "candidate_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"blob_hash" text NOT NULL,
	"filename" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"note" text,
	"fact_count" integer,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"extracted_at" timestamp with time zone,
	CONSTRAINT "candidate_document_user_blob_key" UNIQUE("user_id","blob_hash")
);
--> statement-breakpoint
ALTER TABLE "candidate_document" ADD CONSTRAINT "candidate_document_user_id_candidate_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."candidate"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_document" ADD CONSTRAINT "candidate_document_blob_hash_blob_hash_fk" FOREIGN KEY ("blob_hash") REFERENCES "public"."blob"("hash") ON DELETE no action ON UPDATE no action;