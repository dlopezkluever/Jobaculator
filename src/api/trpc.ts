import { initTRPC, TRPCError } from "@trpc/server";
import type { Db } from "../packages/db/index";
import type { UserId } from "../packages/db/ownership";
import type { Jobs } from "../packages/jobs/index";
import type { Secrets } from "../packages/secrets/index";
import type { Storage } from "../packages/storage/index";

/** What `web` gives every request. `jobs` only sends (§3). */
export type Services = { db: Db; secrets: Secrets; storage: Storage; jobs: Jobs };

/** Identity comes only from the session cookie, never from the client's input (ADR 0006). */
export type Context = Services & { userId: UserId | null };

const t = initTRPC.context<Context>().create();

export const router = t.router;

/** Every procedure requires a signed-in User; there are no public procedures. */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
	return next({ ctx: { ...ctx, userId: ctx.userId } });
});
