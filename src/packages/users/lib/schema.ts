import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Better Auth's core tables, with its own field names (#23: not redesigned). Its
// session, account and verification models are renamed `auth_*` so they cannot be
// mistaken for domain tables. Ids are uuids, so a User's id is a `UserId`.

const timestamps = {
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** Global (ADR 0006): the User identity table. */
export const user = pgTable("user", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").notNull().default(false),
	image: text("image"),
	/** The seeded canary User of the weekly live Dry Runs (§18): SubmitGate refuses Live for it whatever the settings. */
	canary: boolean("canary").notNull().default(false),
	...timestamps,
});

/** Server-side sessions; the cookie holds only the signed token. */
export const authSession = pgTable(
	"auth_session",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		...timestamps,
	},
	(t) => [index("auth_session_user_idx").on(t.userId)],
);

/** Credentials. Phase 0 has only `credential` (email + password) accounts. */
export const authAccount = pgTable(
	"auth_account",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		password: text("password"),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
		scope: text("scope"),
		...timestamps,
	},
	(t) => [index("auth_account_user_idx").on(t.userId)],
);

/** Global (ADR 0006): short-lived tokens Better Auth keys by identifier, not by User. */
export const authVerification = pgTable("auth_verification", {
	id: uuid("id").primaryKey().defaultRandom(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	...timestamps,
});
