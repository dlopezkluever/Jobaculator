import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";
import type { Bullet, ResumeDocument, TemplateId } from "./types";

/**
 * Where the templates and vendored fonts are: beside this file in the source tree, or
 * copied beside the bundled entry points in a release (scripts/build.ts).
 */
function assetsDir(): string {
	for (const candidate of ["./assets/", "./generation-assets/"]) {
		const dir = fileURLToPath(new URL(candidate, import.meta.url));
		if (existsSync(dir)) return dir;
	}
	throw new Error("the resume templates are missing");
}

const FONTS = ["Regular", "SemiBold", "Bold"].map((weight) => `fonts/IBMPlexSans-${weight}.ttf`);
const TEMPLATES: Record<TemplateId, string> = { modern: "modern.typ" };

let compiler: { typst: NodeCompiler; sources: Record<TemplateId, string> } | null = null;
function load() {
	if (compiler) return compiler;
	const dir = assetsDir();
	// System fonts are never searched, so a resume renders the same on every host.
	const typst = NodeCompiler.create({ fontArgs: [{ fontBlobs: FONTS.map((f) => readFileSync(dir + f)) }] });
	const sources = { modern: readFileSync(dir + TEMPLATES.modern, "utf8") };
	compiler = { typst, sources };
	return compiler;
}

export type RenderedResume = { pdf: Buffer; pages: number; trimmedBullets: number };

/** A clean two-page resume is fine (#16); past that, the lowest-priority bullets go. */
export const MAX_PAGES = 2;

function compile(templateId: TemplateId, document: ResumeDocument): { pdf: Buffer; pages: number } {
	const { typst, sources } = load();
	const compiled = typst.compile({ mainFileContent: sources[templateId], inputs: { data: JSON.stringify(document) } });
	if (!compiled.result) {
		const error = compiled.takeError();
		// Diagnostics name template lines, never resume content.
		const detail = error ? typst.fetchDiagnostics(error).map((d: { message?: string }) => d.message) : [];
		throw new Error(`the resume template failed to compile: ${detail.join("; ")}`);
	}
	const pages = compiled.result.numOfPages;
	return { pdf: typst.pdf(compiled.result, { pdfStandard: "ua-1" }), pages };
}

/**
 * Renders the resume through Typst as a tagged PDF/UA-1 (#30). When it runs past
 * `MAX_PAGES`, code trims bullets, lowest priority and oldest entry first, never the last
 * priority-1 bullet of an entry, and never identity or employment and education structure.
 * No regeneration. Deterministic: the same document renders the same bytes.
 */
export function renderResume(templateId: TemplateId, document: ResumeDocument): RenderedResume {
	let current = document;
	let rendered = compile(templateId, current);
	let trimmedBullets = 0;
	while (rendered.pages > MAX_PAGES) {
		const next = withoutOneBullet(current);
		if (!next) break;
		current = next;
		trimmedBullets++;
		rendered = compile(templateId, current);
	}
	return { ...rendered, trimmedBullets };
}

type Section = "experience" | "projects" | "education";

/** The document less its single least valuable bullet, or null when nothing more may go. */
export function withoutOneBullet(document: ResumeDocument): ResumeDocument | null {
	const candidates: { section: Section; entry: number; bullet: number; rank: number[] }[] = [];
	const sections: Section[] = ["experience", "projects", "education"];
	sections.forEach((section, sectionIndex) => {
		document[section].forEach((entry, entryIndex) => {
			const bullets: Bullet[] = entry.bullets;
			const lastOne = bullets.filter((b) => b.priority === 1).length <= 1;
			bullets.forEach((bullet, bulletIndex) => {
				// An entry's top accomplishment stays (#16).
				if (bullet.priority === 1 && lastOne) return;
				// Lowest priority first; then older entries (listed later) and later bullets first.
				candidates.push({
					section,
					entry: entryIndex,
					bullet: bulletIndex,
					rank: [bullet.priority, entryIndex, sectionIndex === 0 ? 0 : 1, bulletIndex],
				});
			});
		});
	});
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => {
		for (let i = 0; i < a.rank.length; i++) {
			const diff = (b.rank[i] ?? 0) - (a.rank[i] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	});
	const [cut] = candidates;
	if (!cut) return null;
	const copy = structuredClone(document);
	copy[cut.section][cut.entry]?.bullets.splice(cut.bullet, 1);
	return copy;
}
