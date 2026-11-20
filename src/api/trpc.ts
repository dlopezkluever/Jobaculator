import { initTRPC, TRPCError } from "@trpc/server";
import type { Db } from "../packages/db/index";
import type { UserId } from "../packages/db/ownership";
import type { Secrets } from "../packages/secrets/index";

/** Identity comes only from the session cookie, never from the client's input (ADR 0006). */
export type Context = { db: Db; secrets: Secrets; userId: UserId | null };

const t = initTRPC.context<Context>().create();

export const router = t.router;

/** Every procedure requires a signed-in User; there are no public procedures. */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
	return next({ ctx: { db: ctx.db, secrets: ctx.secrets, userId: ctx.userId } });
});
