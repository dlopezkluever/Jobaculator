import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor } from "../db/index";
import { type UserId, userIdSchema } from "../db/ownership";
import type { Logger } from "../log/index";
import type { Secret } from "../log/secret";
import { authAccount, authSession, authVerification, user } from "./lib/schema";

/** Where `handler` is mounted in `web`. */
export const AUTH_BASE_PATH = "/api/auth";

const MIN_PASSWORD_LENGTH = 12;
const SESSION_DAYS = 30;
const DAY_SECONDS = 24 * 60 * 60;

/** The only Better Auth endpoints `web` exposes. Registration, self-service resets and account changes stay off (§14). */
const EXPOSED_PATHS = new Set(["/sign-in/email", "/sign-out", "/get-session"].map((p) => AUTH_BASE_PATH + p));

export type Session = { userId: UserId };

export type Users = {
	/** Serves the exposed auth endpoints (sign-in, sign-out, get-session); anything else is 404. */
	handler(request: Request): Promise<Response>;
	/**
	 * The User a request's session cookie belongs to, or null. Read-only: the sliding
	 * 30-day refresh happens when the SPA calls `get-session`, which also re-sets the cookie.
	 */
	getSession(request: Request): Promise<Session | null>;
};

export function createUsers(options: { db: Db; origin: string; secret: Secret<string>; log: Logger }): Users {
	const { log } = options;
	const auth = betterAuth({
		appName: "Jobaculator",
		baseURL: options.origin,
		basePath: AUTH_BASE_PATH,
		trustedOrigins: [options.origin],
		secret: options.secret.reveal(),
		database: drizzleAdapter(options.db, {
			provider: "pg",
			schema: { user, auth_session: authSession, auth_account: authAccount, auth_verification: authVerification },
		}),
		session: { modelName: "auth_session", expiresIn: SESSION_DAYS * DAY_SECONDS, updateAge: DAY_SECONDS },
		account: { modelName: "auth_account" },
		verification: { modelName: "auth_verification" },
		emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: MIN_PASSWORD_LENGTH },
		rateLimit: {
			enabled: true,
			storage: "memory",
			window: 60,
			max: 100,
			customRules: { "/sign-in/email": { window: 60, max: 5 } },
		},
		advanced: {
			cookiePrefix: "jobaculator",
			useSecureCookies: true,
			defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: true, path: "/" },
			database: { generateId: "uuid" },
		},
		telemetry: { enabled: false },
		// Better Auth's messages are fixed strings; their extra arguments may carry request data, so they are dropped.
		logger: {
			level: "warn",
			log: (level, message) => log[level === "debug" ? "debug" : level]({ event: "auth_log", message }),
		},
	});

	return {
		async handler(request) {
			if (!EXPOSED_PATHS.has(new URL(request.url).pathname)) return new Response("Not Found", { status: 404 });
			return auth.handler(request);
		},
		async getSession(request) {
			const result = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });
			if (!result) return null;
			return { userId: userIdSchema.parse(result.user.id) };
		},
	};
}

const newUserSchema = z.object({
	email: z.email().transform((email) => email.toLowerCase()),
	name: z.string().trim().min(1),
	password: z.string().min(MIN_PASSWORD_LENGTH).max(128),
});

export class UserError extends Error {
	override name = "UserError";
}

/**
 * Creates a User with an email + password credential (admin CLI only; registration
 * is off). Pass the caller's transaction to create the User's Candidate with it.
 */
export async function createUser(exec: Executor, input: z.input<typeof newUserSchema>): Promise<UserId> {
	const parsed = newUserSchema.safeParse(input);
	if (!parsed.success) throw new UserError(describeIssues(parsed.error));
	const { email, name, password } = parsed.data;
	const [existing] = await exec.select({ id: user.id }).from(user).where(eq(user.email, email));
	if (existing) throw new UserError("a User with this email already exists");
	const [created] = await exec.insert(user).values({ email, name }).returning({ id: user.id });
	if (!created) throw new UserError("the User was not created");
	const userId = userIdSchema.parse(created.id);
	await exec.insert(authAccount).values({
		userId,
		accountId: userId,
		providerId: "credential",
		password: await hashPassword(password),
	});
	return userId;
}

/** Sets a User's password and signs out every session (admin CLI only). */
export async function resetPassword(exec: Executor, input: { email: string; password: string }): Promise<void> {
	const parsed = newUserSchema.pick({ email: true, password: true }).safeParse(input);
	if (!parsed.success) throw new UserError(describeIssues(parsed.error));
	const { email, password } = parsed.data;
	const [found] = await exec.select({ id: user.id }).from(user).where(eq(user.email, email));
	if (!found) throw new UserError("no User has this email");
	const updated = await exec
		.update(authAccount)
		.set({ password: await hashPassword(password), updatedAt: new Date() })
		.where(and(eq(authAccount.userId, found.id), eq(authAccount.providerId, "credential")))
		.returning({ id: authAccount.id });
	if (updated.length === 0) throw new UserError("the User has no password credential");
	await exec.delete(authSession).where(eq(authSession.userId, found.id));
}

// Names the field and the rule, never the value (passwords pass through here).
function describeIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}
