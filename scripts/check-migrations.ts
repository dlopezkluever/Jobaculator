import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Migrations only expand (§17): each must work with the previous release. This flags
// statements that can break it. Override one statement with a line above it:
//   -- destructive-ok: <why the previous release is unaffected>

const RULES: ReadonlyArray<[string, RegExp]> = [
	["DROP", /\bdrop\s+(table|column|index|view|schema|type|function|trigger|constraint|sequence)\b/i],
	["RENAME", /\brename\b/i],
	["TRUNCATE", /^truncate\b/i],
	["column type change", /\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/i],
	["SET NOT NULL", /\bset\s+not\s+null\b/i],
];

const ADD_COLUMN_NOT_NULL = /\badd\s+column\b[^;]*\bnot\s+null\b/i;
const HAS_DEFAULT = /\bdefault\b/i;
const OVERRIDE = /^\s*--\s*destructive-ok:\s*\S/m;

export type Finding = { statement: number; rule: string; sql: string };

/** Destructive statements in one drizzle-kit migration file (statements split on `--> statement-breakpoint`). */
export function findDestructiveStatements(migration: string): Finding[] {
	const findings: Finding[] = [];
	migration.split("--> statement-breakpoint").forEach((raw, index) => {
		if (OVERRIDE.test(raw)) return;
		const code = raw.replace(/--.*$/gm, "").trim();
		if (!code) return;
		const rules = RULES.filter(([, pattern]) => pattern.test(code)).map(([rule]) => rule);
		if (ADD_COLUMN_NOT_NULL.test(code) && !HAS_DEFAULT.test(code)) rules.push("NOT NULL column without DEFAULT");
		for (const rule of rules) findings.push({ statement: index + 1, rule, sql: code.split("\n")[0] ?? code });
	});
	return findings;
}

if (import.meta.main) {
	const folder = process.argv[2] ?? "drizzle";
	let failed = false;
	for (const file of readdirSync(folder)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		for (const finding of findDestructiveStatements(readFileSync(join(folder, file), "utf8"))) {
			failed = true;
			console.error(`${file} statement ${finding.statement}: ${finding.rule}: ${finding.sql}`);
		}
	}
	if (failed) {
		console.error("Destructive SQL found. Make it expand-only, or add `-- destructive-ok: <reason>` above it.");
		process.exit(1);
	}
	console.log("migrations are expand-only");
}
