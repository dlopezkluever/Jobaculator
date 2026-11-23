import { AwsClient } from "aws4fetch";
import { z } from "zod";
import type { Secret } from "../log/secret";

// The submit-intent journal (§13, #22): an immutable record of every intent to submit, written
// create-only to a separate bucket-locked R2 bucket before the submit-boundary transaction, so
// a restore can never forget a submission. Writes only; normal operation never reads it back,
// except to resolve an ambiguous write of the same intent.

/** One journal entry: identities, mode and time only. No answers, documents or other personal data. */
export const journalEntrySchema = z.object({
	intentId: z.uuid(),
	userId: z.uuid(),
	applicationId: z.uuid(),
	opportunityId: z.uuid(),
	browserRunId: z.uuid(),
	/** The stable posting identity and the normalized dedup key recovery rebuilds from. */
	posting: z.object({ source: z.string(), boardToken: z.string(), nativeId: z.string(), dedupKey: z.string() }),
	/** The apply page, without query or fragment (tracking and auth parameters). */
	applyUrl: z.string(),
	mode: z.enum(["live", "refill_and_submit"]),
	at: z.iso.datetime(),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

/** The journal could not confirm the entry: the run stays before the boundary (a journal Hold). */
export class JournalUnavailable extends Error {
	override name = "JournalUnavailable";
}

export type SubmitJournal = {
	/**
	 * Writes the entry create-only, retrying the same intent id; resolves once it is stored.
	 * An existing entry for the same intent counts as written. Throws `JournalUnavailable`.
	 */
	write(entry: JournalEntry): Promise<void>;
	/** Whether the journal is reachable now: the probe that lifts a journal Hold. */
	check(): Promise<boolean>;
};

/** Strips the query and fragment from a URL for the journal. */
export function journalUrl(url: string): string {
	const parsed = new URL(url);
	return `${parsed.origin}${parsed.pathname}`;
}

export type R2JournalOptions = {
	/** The account's S3 endpoint, such as https://<account>.r2.cloudflarestorage.com. */
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: Secret<string>;
	/** Attempts per write, and the first backoff (doubling). */
	attempts?: number;
	backoffMs?: number;
	fetch?: typeof fetch;
};

/** The journal on R2 (or any S3 API honouring `If-None-Match: *`), with the worker's narrow token. */
export function createR2Journal(options: R2JournalOptions): SubmitJournal {
	const client = new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey.reveal(),
		service: "s3",
		region: "auto",
		retries: 0,
	});
	const doFetch = options.fetch ?? fetch;
	const send = async (url: string, init: RequestInit) => doFetch(await client.sign(url, init));
	const bucketUrl = `${options.endpoint.replace(/\/+$/, "")}/${options.bucket}`;
	const attempts = options.attempts ?? 4;
	const backoffMs = options.backoffMs ?? 500;

	return {
		async write(entry) {
			const parsed = journalEntrySchema.parse(entry);
			const url = `${bucketUrl}/intents/${parsed.intentId}.json`;
			let last = "no attempt";
			for (let attempt = 0; attempt < attempts; attempt++) {
				if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
				try {
					const response = await send(url, {
						method: "PUT",
						body: JSON.stringify(parsed),
						headers: { "Content-Type": "application/json", "If-None-Match": "*" },
					});
					if (response.ok) return;
					if (response.status === 412) {
						// Already stored, perhaps by an earlier attempt whose response was lost: is it this intent?
						const stored = await send(url, { method: "GET" });
						const existing = stored.ok ? journalEntrySchema.safeParse(await stored.json()) : null;
						if (
							existing?.success &&
							existing.data.applicationId === parsed.applicationId &&
							existing.data.browserRunId === parsed.browserRunId
						) {
							return;
						}
						throw new JournalUnavailable("a different entry is stored under this intent id");
					}
					last = `HTTP ${response.status}`;
					// Auth or request errors do not pass by themselves; rate limits and 5xx may.
					if (response.status < 500 && response.status !== 429) break;
				} catch (error) {
					if (error instanceof JournalUnavailable) throw error;
					last = error instanceof Error ? error.name : "error";
				}
			}
			throw new JournalUnavailable(`the journal entry was not confirmed: ${last}`);
		},
		async check() {
			try {
				return (await send(bucketUrl, { method: "HEAD" })).ok;
			} catch {
				return false;
			}
		},
	};
}
