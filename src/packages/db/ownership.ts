import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "./index";

/** The owning User of a record (ADR 0006). Only ever derived from a session or a stored row. */
export type UserId = string & { readonly __brand: "UserId" };

export const userIdSchema = z.uuid().transform((value) => value as UserId);

/**
 * Tables that are global by design and carry no owner (ADR 0006): the User identity
 * table, content-addressed blobs, shared configuration and queue infrastructure, and
 * Better Auth's verification tokens, which are keyed by identifier rather than User, and the
 * system-wide launch gate record.
 * Every other table in the `public` schema must have `user_id ... NOT NULL`.
 */
export const GLOBAL_TABLES: readonly string[] = ["blob", "user", "auth_verification", "launch_step"];

/** Lists tables in the `public` schema that are neither global nor owned by a non-null `user_id`. */
export async function findUnownedTables(
	exec: Executor,
	globalTables: readonly string[] = GLOBAL_TABLES,
): Promise<string[]> {
	const result = await exec.execute<{ table_name: string }>(sql`
		select t.table_name
		from information_schema.tables t
		left join information_schema.columns c
			on c.table_schema = t.table_schema
			and c.table_name = t.table_name
			and c.column_name = 'user_id'
		where t.table_schema = 'public'
			and t.table_type = 'BASE TABLE'
			and (c.column_name is null or c.is_nullable = 'YES')
		order by t.table_name
	`);
	return result.rows.map((row) => row.table_name).filter((name) => !globalTables.includes(name));
}
