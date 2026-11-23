import { type JournalEntry, JournalUnavailable, journalEntrySchema, type SubmitJournal } from "./index";

/**
 * The journal's test double: create-only like R2, in memory. `failing` makes every write and
 * check fail until it is set back to false. Test code only.
 */
export function createMemoryJournal(): SubmitJournal & { entries: Map<string, JournalEntry>; failing: boolean } {
	const entries = new Map<string, JournalEntry>();
	const journal = {
		entries,
		failing: false,
		async write(entry: JournalEntry) {
			const parsed = journalEntrySchema.parse(entry);
			if (journal.failing) throw new JournalUnavailable("the journal is failing");
			const existing = entries.get(parsed.intentId);
			if (existing && existing.browserRunId !== parsed.browserRunId) {
				throw new JournalUnavailable("a different entry is stored under this intent id");
			}
			if (!existing) entries.set(parsed.intentId, parsed);
		},
		async check() {
			return !journal.failing;
		},
	};
	return journal;
}
