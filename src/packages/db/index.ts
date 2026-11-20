import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** A Drizzle database bound to a connection pool. */
export type Db = NodePgDatabase;
/** A Drizzle transaction, as passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that runs queries: the database itself or a caller's transaction. */
export type Executor = Db | Tx;

export type Database = {
	db: Db;
	close(): Promise<void>;
};

export function createDatabase(url: string, options: { max?: number } = {}): Database {
	const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
	return {
		db: drizzle({ client: pool }),
		close: () => pool.end(),
	};
}

/** Applies the committed drizzle-kit SQL migrations in `folder`. */
export async function migrateDatabase(url: string, folder: string): Promise<void> {
	const database = createDatabase(url, { max: 1 });
	try {
		await migrate(database.db, { migrationsFolder: folder });
	} finally {
		await database.close();
	}
}

export type SessionLock = { release(): Promise<void> };

/**
 * Takes a session-level advisory lock on a dedicated connection and holds it until
 * `release()` or the connection drops. Returns null when another session holds it.
 * `onLost` fires if the connection fails while the lock is held.
 */
export async function trySessionLock(
	url: string,
	key: bigint,
	onLost: (error: Error) => void,
): Promise<SessionLock | null> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [key.toString()]);
	if (!result.rows[0]?.locked) {
		await client.end();
		return null;
	}
	let released = false;
	client.on("error", (error) => {
		if (!released) onLost(error);
	});
	return {
		async release() {
			released = true;
			await client.end();
		},
	};
}
