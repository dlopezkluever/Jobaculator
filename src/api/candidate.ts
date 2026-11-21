import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	addDocument,
	DocumentError,
	getKnowledgeBase,
	KnowledgeBaseError,
	listDocuments,
	proposeFacts,
	removeEntry,
	removeFact,
	retryDocument,
} from "../packages/candidate/index";
import { ENTRY_KINDS } from "../packages/candidate/kinds";
import { authedProcedure, router } from "./trpc";

const newEntry = z.object({ ref: z.string().min(1).max(64), kind: z.enum(ENTRY_KINDS) });
const existingEntry = z.object({ id: z.uuid() });
// The SPA names at most a parent and a child, so nesting deeper than one level cannot even be expressed.
const entryRef = z.union([existingEntry, newEntry.extend({ parent: z.union([existingEntry, newEntry]).optional() })]);

/** Everything the SPA writes is the Candidate's own statement: `USER_EXPLICIT`, no inferences. */
const proposeInput = z.object({
	via: z.enum(["about_you", "profile_editor"]),
	facts: z
		.array(
			z.object({
				kind: z.string().min(1).max(64),
				value: z.string().max(4000),
				entry: entryRef.optional(),
				factId: z.uuid().optional(),
			}),
		)
		.min(1)
		.max(100),
});

async function guarded<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof KnowledgeBaseError || error instanceof DocumentError) {
			throw new TRPCError({ code: error.code === "NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST", message: error.message });
		}
		throw error;
	}
}

export const candidateRouter = router({
	knowledgeBase: authedProcedure.query(({ ctx }) => getKnowledgeBase(ctx.db, ctx.userId)),
	propose: authedProcedure
		.input(proposeInput)
		.mutation(({ ctx, input }) =>
			guarded(() => proposeFacts(ctx.db, ctx.userId, { kind: "candidate", via: input.via }, input.facts)),
		),
	removeFact: authedProcedure
		.input(z.object({ factId: z.uuid() }))
		.mutation(({ ctx, input }) => guarded(() => removeFact(ctx.db, ctx.userId, input.factId))),
	removeEntry: authedProcedure
		.input(z.object({ entryId: z.uuid() }))
		.mutation(({ ctx, input }) => guarded(() => removeEntry(ctx.db, ctx.userId, input.entryId))),
	/** Files arrive through `POST /api/candidate/documents` (multipart, one per request); pasted text comes here. */
	documents: router({
		list: authedProcedure.query(({ ctx }) => listDocuments(ctx.db, ctx.userId)),
		paste: authedProcedure
			.input(z.object({ text: z.string().max(1_000_000) }))
			.mutation(({ ctx, input }) => guarded(() => addDocument(ctx, ctx.userId, { pastedText: input.text }))),
		retry: authedProcedure
			.input(z.object({ documentId: z.uuid() }))
			.mutation(({ ctx, input }) => guarded(() => retryDocument(ctx, ctx.userId, input.documentId))),
	}),
});
