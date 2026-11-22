CREATE TABLE "application_package" (
	"application_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"job_snapshot" jsonb NOT NULL,
	"strategy" jsonb,
	"strategy_input_hash" text,
	"strategy_call_id" uuid,
	"resume" jsonb,
	"resume_input_hash" text,
	"resume_call_id" uuid,
	"resume_template" text,
	"resume_pdf" text,
	"resume_pages" integer,
	"failure" jsonb,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_package" ADD CONSTRAINT "application_package_resume_pdf_blob_hash_fk" FOREIGN KEY ("resume_pdf") REFERENCES "public"."blob"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_package" ADD CONSTRAINT "application_package_application_id_user_id_application_id_user_id_fk" FOREIGN KEY ("application_id","user_id") REFERENCES "public"."application"("id","user_id") ON DELETE cascade ON UPDATE no action;