-- ADR 0008: the event stream is append-only.
CREATE FUNCTION event_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'event is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON "event"
	FOR EACH STATEMENT EXECUTE FUNCTION event_reject_change();
--> statement-breakpoint
CREATE TRIGGER event_no_truncate BEFORE TRUNCATE ON "event"
	FOR EACH STATEMENT EXECUTE FUNCTION event_reject_change();
