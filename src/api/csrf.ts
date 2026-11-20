import type { MiddlewareHandler } from "hono";

/**
 * The custom header every state-changing request must carry (§14). A cross-site page
 * cannot set it without a CORS preflight, and `web` grants no preflight. The SPA
 * imports this constant, so keep this file free of runtime imports.
 */
export const CSRF_HEADER = "x-jobaculator-csrf";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Refuses CORS preflights, and any request other than GET or HEAD whose Origin is not
 * `origin` or that lacks `CSRF_HEADER`. Covers tRPC mutations and the auth routes alike.
 */
export function csrfProtection(origin: string): MiddlewareHandler {
	return async (c, next) => {
		if (c.req.method === "OPTIONS") return c.body(null, 403);
		if (!SAFE_METHODS.has(c.req.method) && (c.req.header("origin") !== origin || c.req.header(CSRF_HEADER) !== "1")) {
			return c.json({ error: "cross-site request refused" }, 403);
		}
		await next();
	};
}
