import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Db } from "../packages/db/index";
import type { Logger } from "../packages/log/index";
import { AUTH_BASE_PATH, type Users } from "../packages/users/index";
import { csrfProtection } from "./csrf";
import { appRouter } from "./router";

const TRPC_ENDPOINT = "/api/trpc";

/**
 * The `web` HTTP surface: health, auth routes, the tRPC API and the built SPA, behind
 * strict security headers and CSRF protection on every state-changing /api request.
 */
export function createApp(deps: { db: Db; users: Users; origin: string; log: Logger; spaRoot?: string }): Hono {
	const { db, users, log } = deps;
	const app = new Hono();

	app.use(
		"*",
		secureHeaders({
			contentSecurityPolicy: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'"],
				styleSrc: ["'self'"],
				imgSrc: ["'self'", "data:"],
				fontSrc: ["'self'"],
				connectSrc: ["'self'"],
				objectSrc: ["'none'"],
				baseUri: ["'none'"],
				formAction: ["'self'"],
				frameAncestors: ["'none'"],
			},
			xFrameOptions: "DENY",
			referrerPolicy: "no-referrer",
			permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
		}),
	);

	app.get("/health", async (c) => {
		try {
			await db.execute(sql`select 1`);
			return c.json({ status: "ok" });
		} catch (error) {
			log.warn({ err: error, event: "health_db_unavailable" });
			return c.json({ status: "unavailable" }, 503);
		}
	});

	app.use("/api/*", csrfProtection(deps.origin));
	app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, (c) => users.handler(c.req.raw));
	app.all(`${TRPC_ENDPOINT}/*`, (c) =>
		fetchRequestHandler({
			endpoint: TRPC_ENDPOINT,
			req: c.req.raw,
			router: appRouter,
			createContext: async () => ({ db, userId: (await users.getSession(c.req.raw))?.userId ?? null }),
			onError: ({ error, path }) => {
				if (error.code === "INTERNAL_SERVER_ERROR") log.error({ err: error, event: "trpc_error", path });
			},
		}),
	);
	app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

	if (deps.spaRoot) {
		// Built assets first, then index.html for every other path so client-side routes load.
		app.use("/*", serveStatic({ root: deps.spaRoot }));
		app.get("*", serveStatic({ root: deps.spaRoot, path: "index.html" }));
	}
	return app;
}
