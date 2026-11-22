import type { Executor } from "../../db/index";
import type { UserId } from "../../db/ownership";
import { getKnowledgeBase } from "./read";

/**
 * The Candidate's years of professional experience for the experience stretch (§7): the
 * months covered by any dated role Entry, overlaps counted once. Adjacent experience counts,
 * so every role does. Dates read generously, never against the Candidate: a start year
 * alone is January, an end year alone is December. Null when no role has both dates.
 */
export async function experienceYears(exec: Executor, owner: UserId, now = new Date()): Promise<number | null> {
	const { entries } = await getKnowledgeBase(exec, owner);
	const spans: [number, number][] = [];
	for (const entry of entries) {
		if (entry.kind !== "role") continue;
		const value = (kind: string) => entry.facts.find((fact) => fact.kind === kind)?.value;
		const start = monthIndex(value("start_date"), "start");
		const endValue = value("end_date");
		const end = endValue === "present" ? now.getUTCFullYear() * 12 + now.getUTCMonth() : monthIndex(endValue, "end");
		if (start !== null && end !== null && end >= start) spans.push([start, end]);
	}
	if (spans.length === 0) return null;
	spans.sort((a, b) => a[0] - b[0]);
	let months = 0;
	let [from, to] = spans[0] as [number, number];
	for (const [start, end] of spans.slice(1)) {
		if (start <= to + 1) to = Math.max(to, end);
		else {
			months += to - from + 1;
			[from, to] = [start, end];
		}
	}
	months += to - from + 1;
	return Math.round((months / 12) * 10) / 10;
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as a month count since year 0. */
function monthIndex(value: string | undefined, side: "start" | "end"): number | null {
	const match = value?.match(/^(\d{4})(?:-(\d{2}))?/);
	if (!match) return null;
	const month = match[2] ? Number(match[2]) - 1 : side === "start" ? 0 : 11;
	return Number(match[1]) * 12 + month;
}
