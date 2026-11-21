import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { BudgetExceeded, type LlmClient, LlmError, NoViableRoute, type Part } from "../../ai/index";
import type { Db } from "../../db/index";
import type { UserId } from "../../db/ownership";
import type { Logger } from "../../log/index";
import { parseBlobHash, type Storage } from "../../storage/index";
import { ENTRY_KIND_INFO, ENTRY_KINDS, FACT_KINDS, type FactScope, factKind, kindsFor } from "../kinds";
import { type EntryRef, type ProposedFact, proposeFacts } from "./propose";
import { candidateDocument, type DocumentFormat } from "./schema";

const KIND_NAMES = Object.keys(FACT_KINDS) as [keyof typeof FACT_KINDS, ...(keyof typeof FACT_KINDS)[]];

const extractedFact = z.object({
	kind: z.enum(KIND_NAMES),
	value: z.string(),
	quote: z.string(),
	inferred: z.boolean(),
});

/** What the `extract` task returns. Lenient on purpose: code drops what does not fit instead of failing the document. */
const extraction = z.object({
	facts: z.array(extractedFact),
	entries: z.array(
		z.object({
			key: z.string(),
			kind: z.enum(ENTRY_KINDS),
			parentKey: z.string().nullable(),
			facts: z.array(extractedFact),
		}),
	),
});
type Extraction = z.output<typeof extraction>;
type ExtractedFact = Extraction["facts"][number];

const kindList = (scope: FactScope) => kindsFor(scope).join(", ");

const SYSTEM = `You read one of a job candidate's own documents (a resume, a LinkedIn export, notes) and extract the facts it gives about them.

Every fact has a kind, a value, a quote and inferred:
- quote: the exact text of the document that states the fact, copied character for character. It is checked against the document.
- value: as the document writes it, without expanding abbreviations or rewording, except dates, which use YYYY, YYYY-MM or YYYY-MM-DD, and "present" for an ongoing end date.
- inferred: false when the document states the value outright; true when you concluded it, such as a skill shown by the work described. An inference still quotes its evidence.

Never infer contact details, dates, employers, titles, institutions, degrees, certifications, work authorization, security clearance, notice period or start date: include them only when the document states them. Never infer willingness to relocate or travel, a sponsorship position or pay expectations. Leave out anything the document does not support.

facts: about the candidate as a whole. Kinds: ${kindList("candidate")}.
entries: one per ${ENTRY_KINDS.join(", ")}, each with a key of your choosing and its own facts. Kinds per entry:
${ENTRY_KINDS.map((kind) => `- ${kind}: ${kindList(kind)} (identified by ${ENTRY_KIND_INFO[kind].identity.join(" and ")})`).join("\n")}
A story or project that belongs to a role names that role's key as parentKey; every other entry has parentKey null. Entries nest one level only.

One fact per skill, link, accomplishment, responsibility, technology or course. Use "other" only when no kind fits.`;

const NO_TEXT_LAYER =
	"This PDF has no text layer, so nothing read from it counts as Authoritative. Check the details it gave and correct them where needed.";

class DocumentUnreadable extends Error {}

/**
 * The extraction job for one document (#6, #21): PDFs go to the model natively, DOCX is
 * converted to text first, and the document's own text grounds every claim. A claim the
 * model calls explicit stays explicit only when its quote is in the document's text and
 * contains the value; otherwise it is kept as an inference citing that quote, so it is
 * never Authoritative. Everything goes through `proposeFacts`. A failure is recorded on
 * this document only. A nudge for a document that has moved on does nothing.
 */
export async function extractDocument(
	deps: { db: Db; storage: Storage; llm: LlmClient; log?: Logger },
	owner: UserId,
	documentId: string,
): Promise<void> {
	const { db } = deps;
	const [document] = await db
		.update(candidateDocument)
		.set({ status: "extracting" })
		.where(
			and(
				eq(candidateDocument.id, documentId),
				eq(candidateDocument.userId, owner),
				inArray(candidateDocument.status, ["queued", "extracting"]),
			),
		)
		.returning();
	if (!document) return;

	try {
		const bytes = await deps.storage.get(parseBlobHash(document.blobHash));
		const read = await readDocument(document.format, bytes, document.filename);
		const { output } = await deps.llm.generate({
			task: "extract",
			attribution: { userId: owner },
			system: SYSTEM,
			messages: [{ role: "user", content: read.parts }],
			output: extraction,
			maxOutputTokens: 16_000,
		});
		const facts = ground(output, read.text);
		await db.transaction(async (tx) => {
			const outcomes = facts.length > 0 ? await proposeFacts(tx, owner, { kind: "document", documentId }, facts) : [];
			await tx
				.update(candidateDocument)
				.set({
					status: "extracted",
					factCount: outcomes.length,
					note: read.text.trim() ? null : NO_TEXT_LAYER,
					error: null,
					extractedAt: new Date(),
				})
				.where(eq(candidateDocument.id, documentId));
		});
		deps.log?.info({ event: "document_extracted", documentId, facts: facts.length });
	} catch (error) {
		const message = describeFailure(error);
		if (!(error instanceof DocumentUnreadable || error instanceof LlmError)) {
			deps.log?.error({ err: error, event: "document_extraction_failed", documentId });
		} else {
			deps.log?.warn({ event: "document_extraction_failed", documentId, reason: message });
		}
		await db
			.update(candidateDocument)
			.set({ status: "failed", error: message })
			.where(eq(candidateDocument.id, documentId));
	}
}

/** The document as the model sees it, and its deterministic text for grounding. */
async function readDocument(
	format: DocumentFormat,
	bytes: Buffer,
	filename: string,
): Promise<{ text: string; parts: Part[] }> {
	const ask: Part = { type: "text", text: "Extract the facts this document gives about the candidate." };
	if (format === "pdf") return { text: await pdfText(bytes), parts: [{ type: "pdf", data: bytes, filename }, ask] };
	const text = format === "docx" ? await docxText(bytes) : bytes.toString("utf8");
	if (!text.trim()) throw new DocumentUnreadable("The document has no text in it.");
	return {
		text,
		parts: [{ type: "text", text: `<document name=${JSON.stringify(filename)}>\n${text}\n</document>` }, ask],
	};
}

async function pdfText(bytes: Buffer): Promise<string> {
	// Loaded on first use, so `web`, which imports this module but never extracts, does not load pdf.js.
	const { getDocument, VerbosityLevel } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	// pdf.js takes ownership of the array it is given, so it gets a copy.
	const task = getDocument({
		data: new Uint8Array(bytes),
		useSystemFonts: false,
		verbosity: VerbosityLevel.ERRORS,
	});
	try {
		const pdf = await task.promise;
		let text = "";
		for (let number = 1; number <= pdf.numPages; number++) {
			const content = await (await pdf.getPage(number)).getTextContent();
			for (const item of content.items) if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
			text += "\n";
		}
		return text;
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		if (name === "PasswordException") {
			throw new DocumentUnreadable("The PDF is password-protected. Remove the password and upload it again.");
		}
		throw new DocumentUnreadable("The file could not be read as a PDF. It may be damaged.");
	} finally {
		await task.destroy();
	}
}

async function docxText(bytes: Buffer): Promise<string> {
	const mammoth = await import("mammoth");
	try {
		return (await mammoth.extractRawText({ buffer: bytes })).value;
	} catch {
		throw new DocumentUnreadable("The file could not be read as a DOCX document. It may be damaged.");
	}
}

/** Letters and digits only, so line breaks, hyphenation and spacing in a PDF's text layer do not matter. */
const squash = (value: string) =>
	value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");

/** The proposal for `proposeFacts`: claims that fit the registry, explicit only when the document's text bears them out. */
function ground(output: Extraction, documentText: string): ProposedFact[] {
	const text = squash(documentText);
	const states = (fact: ExtractedFact) => {
		const quote = squash(fact.quote);
		// A date is written differently in the document ("March 2021") than in the value (2021-03).
		const valueInQuote = factKind(fact.kind).input === "date" || quote.includes(squash(fact.value));
		return quote.length > 0 && text.includes(quote) && valueInQuote;
	};
	const proposed = (fact: ExtractedFact, scope: FactScope, entry?: EntryRef): ProposedFact[] => {
		if (!kindsFor(scope).includes(fact.kind)) return [];
		if (!factKind(fact.kind).schema.safeParse(fact.value).success) return [];
		if (!fact.inferred && states(fact)) return [{ kind: fact.kind, value: fact.value, ...(entry ? { entry } : {}) }];
		const quote = fact.quote.trim();
		if (!quote) return [];
		return [{ kind: fact.kind, value: fact.value, ...(entry ? { entry } : {}), inference: { evidence: [quote] } }];
	};

	const byKey = new Map(output.entries.map((entry, index) => [entry.key, { entry, ref: `entry-${index}` }]));
	return [
		...output.facts.flatMap((fact) => proposed(fact, "candidate")),
		...output.entries.flatMap((entry, index) => {
			const parent = entry.parentKey === null ? undefined : byKey.get(entry.parentKey);
			// Only one level deep: a parent that has a parent of its own is ignored.
			const nests = parent && parent.entry !== entry && parent.entry.parentKey === null;
			const ref: EntryRef = {
				ref: `entry-${index}`,
				kind: entry.kind,
				...(nests ? { parent: { ref: parent.ref, kind: parent.entry.kind } } : {}),
			};
			return entry.facts.flatMap((fact) => proposed(fact, entry.kind, ref));
		}),
	];
}

function describeFailure(error: unknown): string {
	if (error instanceof DocumentUnreadable) return error.message;
	if (error instanceof BudgetExceeded) {
		return "Today's AI spend cap is reached. Raise it in Settings, or retry tomorrow.";
	}
	if (error instanceof NoViableRoute) {
		return error.scopes.every((scope) => scope.startsWith("key:"))
			? "No AI key is set up to read documents. Add one in Settings, then retry."
			: "The AI providers are unavailable right now. Retry in a few minutes.";
	}
	if (error instanceof LlmError) {
		if (error.kind === "transient") return "The AI provider is unavailable right now. Retry in a few minutes.";
		if (error.kind === "shared") return "The AI key or provider failed. Check Settings, then retry.";
		return "The AI could not read this document. Retry, or paste its text instead.";
	}
	return "Something went wrong reading this document. Retry it.";
}
