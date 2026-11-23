import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Tx } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { appendEvent, defineEvent } from "../../events/index";
import type {
	ApplicationAnswer,
	Escalation,
	JobSnapshot,
	ResumeDocument,
	Strategy,
	TemplateId,
} from "../../generation/index";
import type { BlobHash } from "../../storage/index";
import { applicationPackage } from "./schema";
import { APPLICATION_SUBJECT, type PreparationFailure } from "./types";

export const jobSnapshotCaptured = defineEvent({
	code: "job_snapshot_captured",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ sightingId: z.uuid(), enriched: z.boolean() }),
});
export const strategyWritten = defineEvent({
	code: "strategy_written",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ callId: z.uuid() }),
});
export const resumeWritten = defineEvent({
	code: "resume_written",
	subject: APPLICATION_SUBJECT,
	payload: z.object({
		callId: z.uuid(),
		templateId: z.string(),
		pages: z.int(),
		/** Generated claims dropped for an invalid citation. */
		droppedClaims: z.int(),
		/** Lowest-priority bullets cut so the resume fits. */
		trimmedBullets: z.int(),
	}),
});
export const answersWritten = defineEvent({
	code: "answers_written",
	subject: APPLICATION_SUBJECT,
	payload: z.object({
		callId: z.uuid().nullable(),
		questions: z.int(),
		/** Answered by code, from an Answer Policy, an Authoritative Fact or a decline. */
		deterministic: z.int(),
		blank: z.int(),
		/** Model answers dropped for an invalid citation or a choice the form does not offer. */
		droppedAnswers: z.int(),
		/** The questions that need the Candidate (narrow escalation, #16). */
		escalations: z.array(
			z.object({
				questionId: z.string(),
				escalation: z.enum(["AUTHORITATIVE_FACT_REQUIRED", "ASSESSMENT_REQUIRED"]),
			}),
		),
	}),
});
/** Answers a Browser Run generated for questions it found on the live form (§9 mid-run generation). */
export const answersAdded = defineEvent({
	code: "answers_added",
	subject: APPLICATION_SUBJECT,
	payload: z.object({
		browserRunId: z.uuid(),
		callId: z.uuid().nullable(),
		questions: z.int(),
		escalations: z.array(
			z.object({
				questionId: z.string(),
				escalation: z.enum(["AUTHORITATIVE_FACT_REQUIRED", "ASSESSMENT_REQUIRED"]),
			}),
		),
	}),
});
/** Paid retries stopped after the same AI failure repeated; resumes when the User's AI setup changes. */
export const preparationSuspended = defineEvent({
	code: "preparation_suspended",
	subject: APPLICATION_SUBJECT,
	payload: z.object({ errorClass: z.string(), failures: z.int() }),
});
export const preparationResumed = defineEvent({
	code: "preparation_resumed",
	subject: APPLICATION_SUBJECT,
	payload: z.object({}),
});

export type Package = {
	applicationId: string;
	jobSnapshot: JobSnapshot;
	strategy: Strategy | null;
	strategyInputHash: string | null;
	resume: ResumeDocument | null;
	resumeInputHash: string | null;
	resumeTemplate: TemplateId | null;
	resumePdf: BlobHash | null;
	resumePages: number | null;
	answers: ApplicationAnswer[] | null;
	failure: PreparationFailure | null;
	suspendedAt: Date | null;
	updatedAt: Date;
};

const columns = {
	applicationId: applicationPackage.applicationId,
	jobSnapshot: applicationPackage.jobSnapshot,
	strategy: applicationPackage.strategy,
	strategyInputHash: applicationPackage.strategyInputHash,
	resume: applicationPackage.resume,
	resumeInputHash: applicationPackage.resumeInputHash,
	resumeTemplate: applicationPackage.resumeTemplate,
	resumePdf: applicationPackage.resumePdf,
	resumePages: applicationPackage.resumePages,
	answers: applicationPackage.answers,
	failure: applicationPackage.failure,
	suspendedAt: applicationPackage.suspendedAt,
	updatedAt: applicationPackage.updatedAt,
};

const toPackage = (row: Omit<Package, "resumePdf"> & { resumePdf: string | null }): Package => ({
	...row,
	resumePdf: row.resumePdf as BlobHash | null,
});

const owned = (owner: UserId, applicationId: string) =>
	and(eq(applicationPackage.applicationId, applicationId), eq(applicationPackage.userId, owner));

/** The Application's Package, or null when preparation has not started or it is another User's. */
export async function getPackage(exec: Executor, owner: UserId, applicationId: string): Promise<Package | null> {
	const [found] = await exec.select(columns).from(applicationPackage).where(owned(owner, applicationId));
	return found ? toPackage(found) : null;
}

/**
 * Starts the Package with its Job Snapshot (§13). The snapshot is written once: a Package that
 * already exists keeps its own, and this returns it unchanged.
 */
export async function startPackage(
	tx: Tx,
	owner: UserId,
	applicationId: string,
	snapshot: JobSnapshot,
): Promise<Package> {
	const [created] = await tx
		.insert(applicationPackage)
		.values({ applicationId, userId: owner, jobSnapshot: snapshot })
		.onConflictDoNothing()
		.returning(columns);
	if (created) {
		await appendEvent(tx, owner, jobSnapshotCaptured, applicationId, {
			sightingId: snapshot.sightingId,
			enriched: snapshot.enriched,
		});
		return toPackage(created);
	}
	const existing = await getPackage(tx, owner, applicationId);
	if (!existing) throw new Error("the Package is missing");
	return existing;
}

/** Stores the Strategy unless one is stored already (it is generated once, #16). */
export async function saveStrategy(
	tx: Tx,
	owner: UserId,
	applicationId: string,
	written: { strategy: Strategy; inputHash: string; callId: string },
): Promise<boolean> {
	const [saved] = await tx
		.update(applicationPackage)
		.set({
			strategy: written.strategy,
			strategyInputHash: written.inputHash,
			strategyCallId: written.callId,
			updatedAt: new Date(),
		})
		.where(and(owned(owner, applicationId), isNull(applicationPackage.strategy)))
		.returning({ id: applicationPackage.applicationId });
	if (!saved) return false;
	await appendEvent(tx, owner, strategyWritten, applicationId, { callId: written.callId });
	return true;
}

/** Stores the tailored resume's content and its rendered PDF together, unless a resume is stored already. */
export async function saveResume(
	tx: Tx,
	owner: UserId,
	applicationId: string,
	written: {
		document: ResumeDocument;
		inputHash: string;
		callId: string;
		templateId: TemplateId;
		pdf: BlobHash;
		pages: number;
		droppedClaims: number;
		trimmedBullets: number;
	},
): Promise<boolean> {
	const [saved] = await tx
		.update(applicationPackage)
		.set({
			resume: written.document,
			resumeInputHash: written.inputHash,
			resumeCallId: written.callId,
			resumeTemplate: written.templateId,
			resumePdf: written.pdf,
			resumePages: written.pages,
			updatedAt: new Date(),
		})
		.where(and(owned(owner, applicationId), isNull(applicationPackage.resume)))
		.returning({ id: applicationPackage.applicationId });
	if (!saved) return false;
	await appendEvent(tx, owner, resumeWritten, applicationId, {
		callId: written.callId,
		templateId: written.templateId,
		pages: written.pages,
		droppedClaims: written.droppedClaims,
		trimmedBullets: written.trimmedBullets,
	});
	return true;
}

/** Stores the Application Answers unless answers are stored already; they are not regenerated (#16). */
export async function saveAnswers(
	tx: Tx,
	owner: UserId,
	applicationId: string,
	written: { answers: ApplicationAnswer[]; inputHash: string; callId: string | null; droppedAnswers: number },
): Promise<boolean> {
	const [saved] = await tx
		.update(applicationPackage)
		.set({
			answers: written.answers,
			answersInputHash: written.inputHash,
			answersCallId: written.callId,
			updatedAt: new Date(),
		})
		.where(and(owned(owner, applicationId), isNull(applicationPackage.answers)))
		.returning({ id: applicationPackage.applicationId });
	if (!saved) return false;
	const { answers } = written;
	await appendEvent(tx, owner, answersWritten, applicationId, {
		callId: written.callId,
		questions: answers.length,
		deterministic: answers.filter((a) => a.via !== null && a.via !== "MODEL").length,
		blank: answers.filter((a) => a.via === null).length,
		droppedAnswers: written.droppedAnswers,
		escalations: answers.flatMap((a) =>
			a.escalation ? [{ questionId: a.question.id, escalation: a.escalation satisfies Escalation }] : [],
		),
	});
	return true;
}

/**
 * Adds answers to questions the Package has none for, as a Browser Run discovers them (§10):
 * the Package answers each question once, so answers it already has stay as they are.
 * Returns the answers it added.
 */
export async function addAnswers(
	tx: Tx,
	owner: UserId,
	applicationId: string,
	added: { browserRunId: string; callId: string | null; answers: ApplicationAnswer[] },
): Promise<ApplicationAnswer[]> {
	const [row] = await tx
		.select({ answers: applicationPackage.answers })
		.from(applicationPackage)
		.where(owned(owner, applicationId))
		.for("update");
	if (!row) throw new Error("the Package is missing");
	const known = new Set((row.answers ?? []).map((a) => a.question.id));
	const fresh = added.answers.filter((a) => !known.has(a.question.id));
	if (fresh.length === 0) return [];
	await tx
		.update(applicationPackage)
		.set({ answers: [...(row.answers ?? []), ...fresh], updatedAt: new Date() })
		.where(owned(owner, applicationId));
	await appendEvent(tx, owner, answersAdded, applicationId, {
		browserRunId: added.browserRunId,
		callId: added.callId,
		questions: fresh.length,
		escalations: fresh.flatMap((a) =>
			a.escalation ? [{ questionId: a.question.id, escalation: a.escalation satisfies Escalation }] : [],
		),
	});
	return fresh;
}

/**
 * Records an AI failure of preparation. The same fingerprint again counts up; a different one
 * starts over. At `suspendAfter` in a row, paid retries are suspended (one event, the notice).
 * Returns the count and whether this call suspended it.
 */
export async function recordPreparationFailure(
	tx: Tx,
	owner: UserId,
	applicationId: string,
	failed: { fingerprint: string; errorClass: string; suspendAfter: number; now?: Date },
): Promise<{ count: number; suspended: boolean }> {
	const now = failed.now ?? new Date();
	const [row] = await tx
		.select({ failure: applicationPackage.failure, suspendedAt: applicationPackage.suspendedAt })
		.from(applicationPackage)
		.where(owned(owner, applicationId))
		.for("update");
	if (!row) throw new Error("the Package is missing");
	const count = row.failure?.fingerprint === failed.fingerprint ? row.failure.count + 1 : 1;
	const suspend = row.suspendedAt === null && count >= failed.suspendAfter;
	await tx
		.update(applicationPackage)
		.set({
			failure: { fingerprint: failed.fingerprint, errorClass: failed.errorClass, count, at: now.toISOString() },
			...(suspend ? { suspendedAt: now } : {}),
			updatedAt: now,
		})
		.where(owned(owner, applicationId));
	if (suspend) {
		await appendEvent(tx, owner, preparationSuspended, applicationId, {
			errorClass: failed.errorClass,
			failures: count,
		});
	}
	return { count, suspended: suspend };
}

/** Clears the failure record after a step succeeds, and lifts a suspension (with its event). */
export async function clearPreparationFailure(tx: Tx, owner: UserId, applicationId: string): Promise<void> {
	const [row] = await tx
		.select({ failure: applicationPackage.failure, suspendedAt: applicationPackage.suspendedAt })
		.from(applicationPackage)
		.where(owned(owner, applicationId))
		.for("update");
	if (!row || (row.failure === null && row.suspendedAt === null)) return;
	await tx
		.update(applicationPackage)
		.set({ failure: null, suspendedAt: null, updatedAt: new Date() })
		.where(owned(owner, applicationId));
	if (row.suspendedAt) await appendEvent(tx, owner, preparationResumed, applicationId, {});
}
