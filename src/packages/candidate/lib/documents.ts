import { extname } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { defineQueue, type Jobs } from "../../jobs/index";
import type { Storage } from "../../storage/index";
import { blob } from "../../storage/tables";
import { candidateDocument, type DocumentFormat, type DocumentStatus } from "./schema";

/** About 10 MB per file and about 20 files per batch (#21). The SPA sends one file per request. */
export const DOCUMENT_LIMITS = { maxBytes: 10 * 1024 * 1024, maxBatch: 20 } as const;

/** One extraction job per document. */
export const EXTRACT_DOCUMENT = defineQueue("extract_document", { documentId: z.uuid() });

export type Document = {
	id: string;
	filename: string;
	format: DocumentFormat;
	size: number;
	status: DocumentStatus;
	error: string | null;
	note: string | null;
	factCount: number | null;
	createdAt: Date;
	extractedAt: Date | null;
};

export class DocumentError extends Error {
	override name = "DocumentError";
	constructor(
		readonly code: "REJECTED" | "NOT_FOUND",
		message: string,
	) {
		super(message);
	}
}

const FORMATS: Record<string, DocumentFormat> = {
	".pdf": "pdf",
	".docx": "docx",
	".txt": "text",
	".text": "text",
	".md": "markdown",
	".markdown": "markdown",
};

const MEDIA_TYPES: Record<DocumentFormat, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	text: "text/plain; charset=utf-8",
	markdown: "text/markdown; charset=utf-8",
};

const rejected = (message: string) => new DocumentError("REJECTED", message);

/** Accepts PDF, DOCX, TXT and Markdown by extension, checked against the bytes; everything else is rejected. */
function classify(filename: string, bytes: Buffer): DocumentFormat {
	const format = FORMATS[extname(filename).toLowerCase()];
	if (!format) throw rejected("Only PDF, DOCX, TXT and Markdown files are accepted.");
	if (bytes.length === 0) throw rejected("The file is empty.");
	if (bytes.length > DOCUMENT_LIMITS.maxBytes) throw rejected("The file is larger than 10 MB.");
	if (format === "pdf" && !bytes.subarray(0, 1024).includes("%PDF-")) throw rejected("The file is not a PDF.");
	// A DOCX is a ZIP archive.
	if (format === "docx" && bytes.readUInt32LE(0) !== 0x04034b50) throw rejected("The file is not a DOCX document.");
	if (format === "text" || format === "markdown") {
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw rejected("The file is not UTF-8 text.");
		}
		if (text.includes("\0")) throw rejected("The file is not UTF-8 text.");
	}
	return format;
}

/** The name the Candidate sees: the base name, without control characters, at most 200 characters. */
function cleanFilename(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	return (
		base
			.replace(/\p{Cc}/gu, "")
			.trim()
			.slice(0, 200) || "Untitled"
	);
}

export type DocumentUpload = { filename: string; bytes: Buffer } | { pastedText: string };

/**
 * Keeps the original bytes as a permanent blob and records the document, then queues its
 * extraction in the same transaction. The same bytes uploaded again are skipped: the
 * existing document is returned with `duplicate`.
 */
export async function addDocument(
	deps: { db: Db; storage: Storage; jobs: Jobs },
	owner: UserId,
	upload: DocumentUpload,
): Promise<{ document: Document; duplicate: boolean }> {
	let filename: string;
	let bytes: Buffer;
	let format: DocumentFormat;
	if ("pastedText" in upload) {
		if (!upload.pastedText.trim()) throw rejected("There is no text to add.");
		filename = "Pasted text";
		bytes = Buffer.from(upload.pastedText.trim(), "utf8");
		if (bytes.length > DOCUMENT_LIMITS.maxBytes) throw rejected("The text is longer than 10 MB.");
		format = "text";
	} else {
		filename = cleanFilename(upload.filename);
		bytes = upload.bytes;
		format = classify(filename, bytes);
	}

	return deps.db.transaction(async (tx) => {
		const hash = await deps.storage.put(tx, bytes, { mediaType: MEDIA_TYPES[format], retentionClass: "permanent" });
		const [created] = await tx
			.insert(candidateDocument)
			.values({ userId: owner, blobHash: hash, filename, format })
			.onConflictDoNothing()
			.returning({ id: candidateDocument.id });
		if (created) await deps.jobs.send(EXTRACT_DOCUMENT, { userId: owner, documentId: created.id }, { tx });
		const [document] = await selectDocuments(tx, owner, created ? { id: created.id } : { blobHash: hash });
		if (!document) throw new Error("the document was not recorded");
		return { document, duplicate: !created };
	});
}

/** The Candidate's documents, newest first. */
export function listDocuments(exec: Executor, owner: UserId): Promise<Document[]> {
	return selectDocuments(exec, owner, {});
}

/** Queues a failed document's extraction again. */
export async function retryDocument(deps: { db: Db; jobs: Jobs }, owner: UserId, documentId: string): Promise<void> {
	await deps.db.transaction(async (tx) => {
		const retried = await tx
			.update(candidateDocument)
			.set({ status: "queued", error: null })
			.where(
				and(
					eq(candidateDocument.id, documentId),
					eq(candidateDocument.userId, owner),
					eq(candidateDocument.status, "failed"),
				),
			)
			.returning({ id: candidateDocument.id });
		if (retried.length === 0) throw new DocumentError("NOT_FOUND", "No failed document to retry.");
		await deps.jobs.send(EXTRACT_DOCUMENT, { userId: owner, documentId }, { tx });
	});
}

function selectDocuments(exec: Executor, owner: UserId, by: { id?: string; blobHash?: string }): Promise<Document[]> {
	return exec
		.select({
			id: candidateDocument.id,
			filename: candidateDocument.filename,
			format: candidateDocument.format,
			size: blob.size,
			status: candidateDocument.status,
			error: candidateDocument.error,
			note: candidateDocument.note,
			factCount: candidateDocument.factCount,
			createdAt: candidateDocument.createdAt,
			extractedAt: candidateDocument.extractedAt,
		})
		.from(candidateDocument)
		.innerJoin(blob, eq(blob.hash, candidateDocument.blobHash))
		.where(
			and(
				eq(candidateDocument.userId, owner),
				by.id === undefined ? undefined : eq(candidateDocument.id, by.id),
				by.blobHash === undefined ? undefined : eq(candidateDocument.blobHash, by.blobHash),
			),
		)
		.orderBy(desc(candidateDocument.createdAt));
}
