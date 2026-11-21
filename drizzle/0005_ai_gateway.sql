CREATE TABLE "ai_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"measured_micro_usd" bigint,
	"price_table_version" text NOT NULL,
	"price_snapshot" jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"request_id" text,
	"outcome" text,
	"error_kind" text,
	"error_scope" text,
	"fingerprint" text,
	"hunt_id" uuid,
	"application_id" uuid,
	"browser_run_id" uuid,
	"opportunity_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_call_payload" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_scope_health" (
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"unhealthy_until" timestamp with time zone NOT NULL,
	"error_class" text NOT NULL,
	CONSTRAINT "ai_scope_health_user_id_scope_pk" PRIMARY KEY("user_id","scope")
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preset" text DEFAULT 'standard' NOT NULL,
	"task_presets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"daily_cap_micro_usd" bigint,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_key_user_provider_unique" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "ai_call" ADD CONSTRAINT "ai_call_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_payload" ADD CONSTRAINT "ai_call_payload_call_id_ai_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."ai_call"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_payload" ADD CONSTRAINT "ai_call_payload_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_scope_health" ADD CONSTRAINT "ai_scope_health_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_key" ADD CONSTRAINT "provider_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_call_user_started_idx" ON "ai_call" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "ai_call_payload_created_idx" ON "ai_call_payload" USING btree ("created_at");--> statement-breakpoint
-- §12: the ledger is append-only. A reservation is finalised exactly once; after that
-- the row never changes, and no row is ever deleted.
CREATE FUNCTION ai_call_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD.finished_at IS NULL AND OLD.reserved_micro_usd = NEW.reserved_micro_usd
		AND OLD.user_id = NEW.user_id AND OLD.started_at = NEW.started_at THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'ai_call is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_call_append_only BEFORE UPDATE OR DELETE ON "ai_call"
	FOR EACH ROW EXECUTE FUNCTION ai_call_reject_change();
--> statement-breakpoint
CREATE TRIGGER ai_call_no_truncate BEFORE TRUNCATE ON "ai_call"
	FOR EACH STATEMENT EXECUTE FUNCTION ai_call_reject_change();
