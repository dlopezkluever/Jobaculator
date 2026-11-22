import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { getPackage } from "../packages/applications/index";
import { addDocument, DOCUMENT_LIMITS, DocumentError } from "../packages/candidate/index";
import type { Logger } from "../packages/log/index";
import { AUTH_BASE_PATH, type Users } from "../packages/users/index";
import { csrfProtection } from "./csrf";
import { appRouter } from "./router";
import type { Services } from "./trpc";

const TRPC_ENDPOINT = "/api/trpc";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `web` HTTP surface: health, auth routes, the tRPC API and the built SPA, behind
 * strict security headers and CSRF protection on every state-changing /api request.
 */
export function createApp(
	deps: Services & {
		users: Users;
		origin: string;
		log: Logger;
		spaRoot?: string;
	},
): Hono {
	const { db, secrets, storage, jobs, users, log } = deps;
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
			createContext: async () => ({
				db,
				secrets,
				storage,
				jobs,
				userId: (await users.getSession(c.req.raw))?.userId ?? null,
			}),
			onError: ({ error, path }) => {
				if (error.code === "INTERNAL_SERVER_ERROR") log.error({ err: error, event: "trpc_error", path });
			},
		}),
	);
	// One file per request, so `web` never holds a whole batch in memory.
	app.post(
		"/api/candidate/documents",
		bodyLimit({
			maxSize: DOCUMENT_LIMITS.maxBytes + 64 * 1024,
			onError: (c) => c.json({ error: "The file is larger than 10 MB." }, 413),
		}),
		async (c) => {
			const session = await users.getSession(c.req.raw);
			if (!session) return c.json({ error: "unauthorized" }, 401);
			const file = (await c.req.formData().catch(() => null))?.get("file");
			if (!(file instanceof File)) return c.json({ error: "Send one file in the `file` field." }, 400);
			try {
				const bytes = Buffer.from(await file.arrayBuffer());
				return c.json(await addDocument(deps, session.userId, { filename: file.name, bytes }));
			} catch (error) {
				if (error instanceof DocumentError) return c.json({ error: error.message }, 400);
				log.error({ err: error, event: "document_upload_failed" });
				return c.json({ error: "The upload failed. Try again." }, 500);
			}
		},
	);
	// Downloads resolve an owner-scoped domain reference, never a raw blob hash (§13).
	app.get("/api/applications/:id/resume.pdf", async (c) => {
		const session = await users.getSession(c.req.raw);
		if (!session) return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		const pkg = UUID.test(id) ? await getPackage(db, session.userId, id) : null;
		if (!pkg?.resumePdf) return c.json({ error: "not found" }, 404);
		const bytes = await storage.get(pkg.resumePdf);
		const name = pkg.resume?.identity.name.replace(/[^\p{L}\p{N} .-]+/gu, "").trim() || "Resume";
		return c.body(new Uint8Array(bytes), 200, {
			"Content-Type": "application/pdf",
			"Content-Disposition": `attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent(`${name} Resume.pdf`)}`,
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-store",
		});
	});
	app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

	if (deps.spaRoot) {
		// Built assets first, then index.html for every other path so client-side routes load.
		app.use("/*", serveStatic({ root: deps.spaRoot }));
		app.get("*", serveStatic({ root: deps.spaRoot, path: "index.html" }));
	}
	return app;
}
