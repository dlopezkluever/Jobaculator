import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findDestructiveStatements } from "./check-migrations";

const rules = (sql: string) => findDestructiveStatements(sql).map((f) => f.rule);

describe("findDestructiveStatements", () => {
	it.each([
		['DROP TABLE "hunt";', "DROP"],
		['ALTER TABLE "hunt" DROP COLUMN "name";', "DROP"],
		['ALTER TABLE "hunt" RENAME COLUMN "a" TO "b";', "RENAME"],
		['ALTER TABLE "hunt" ALTER COLUMN "fit" SET DATA TYPE integer;', "column type change"],
		['ALTER TABLE "hunt" ALTER COLUMN "fit" SET NOT NULL;', "SET NOT NULL"],
		['ALTER TABLE "hunt" ADD COLUMN "fit" integer NOT NULL;', "NOT NULL column without DEFAULT"],
		['TRUNCATE "hunt";', "TRUNCATE"],
	])("flags %s", (sql, rule) => {
		expect(rules(sql)).toContain(rule);
	});

	it.each([
		'ALTER TABLE "hunt" ADD COLUMN "fit" integer NOT NULL DEFAULT 0;',
		'ALTER TABLE "hunt" ADD COLUMN "dropped_at" timestamp;',
		'CREATE INDEX "hunt_rename_idx" ON "hunt" ("user_id");',
		'-- we never DROP anything here\nCREATE TABLE "x" (id int);',
	])("allows %s", (sql) => {
		expect(rules(sql)).toEqual([]);
	});

	it("counts statements and honours a per-statement override", () => {
		const sql = [
			'CREATE TABLE "a" (id int);',
			'-- destructive-ok: "old" was never read by any release\nDROP TABLE "old";',
			'DROP TABLE "other";',
		].join("\n--> statement-breakpoint\n");
		expect(findDestructiveStatements(sql)).toEqual([{ statement: 3, rule: "DROP", sql: 'DROP TABLE "other";' }]);
	});

	it("passes every committed migration", () => {
		for (const file of readdirSync("drizzle").filter((f) => f.endsWith(".sql"))) {
			expect(findDestructiveStatements(readFileSync(`drizzle/${file}`, "utf8")), file).toEqual([]);
		}
	});
});
