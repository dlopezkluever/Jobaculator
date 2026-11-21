import { createHash } from "node:crypto";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { SourcePosting } from "./types";

// The normalization boundary (§6): only source-stated fields and unambiguous deterministic
// transforms. Everything inferred (seniority, remote-from-prose, ...) belongs to matching.

/** Query parameters that only track where a click came from; identity-bearing ones such as `gh_jid` stay. */
const TRACKING_PARAM = /^(utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|gh_src|lever-source.*|lever-origin)$/i;

/** The URL with tracking parameters, the fragment and a trailing slash removed, and parameters sorted. */
export function canonicalUrl(value: string): string {
	const url = new URL(value);
	url.hash = "";
	if (url.protocol === "http:") url.protocol = "https:";
	const kept = [...url.searchParams]
		.filter(([key]) => !TRACKING_PARAM.test(key))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	url.search = new URLSearchParams(kept).toString();
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
	return url.toString();
}

const SAFE_HREF = /^(https?:|mailto:)/i;

/**
 * Hostile-content handling for display (#23): the dashboard only ever gets this Markdown.
 * Scripts, styles, embeds, forms and images are dropped, links keep only http(s) and
 * mailto targets (canonicalized), and `<`/`>` in text are escaped so no raw HTML survives.
 */
const markdown = new NodeHtmlMarkdown(
	{
		ignore: ["script", "style", "noscript", "iframe", "object", "embed", "template", "form", "svg", "head", "title"],
		globalEscape: [/[\\`*_~[\]<>]/gm, "\\$&"],
		maxConsecutiveNewlines: 2,
	},
	{
		img: { ignore: true },
		a: ({ node, visitor }) => {
			const href = node.getAttribute("href")?.trim() ?? "";
			if (!SAFE_HREF.test(href)) return {};
			let target: string;
			try {
				target = href.toLowerCase().startsWith("mailto:") ? href : canonicalUrl(href);
			} catch {
				return {};
			}
			return {
				prefix: "[",
				postfix: `](${target.replace(/[()<> ]/g, encodeURIComponent)})`,
				childTranslators: visitor.instance.aTagTranslators,
				postprocess: ({ content }) => content.replace(/(?:\r?\n)+/g, " "),
			};
		},
	},
);

export function sanitizedMarkdown(html: string): string {
	return markdown.translate(html).trim();
}

export type NormalizedPosting = {
	title: string;
	/** Case- and spacing-folded title, for exact comparisons. */
	titleNormalized: string;
	employerName: string;
	locationText: string | null;
	workplaceType: SourcePosting["workplaceType"];
	employmentType: string | null;
	salary: SourcePosting["salary"];
	canonicalUrl: string;
	descriptionMarkdown: string | null;
	firstPublishedAt: Date | null;
};

const squash = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const orNull = (text: string | null) => (text === null ? null : squash(text) || null);

/** `employerFallback` is the watched Board's Employer, used when the posting states none. */
export function normalizePosting(posting: SourcePosting, employerFallback: string): NormalizedPosting {
	const title = squash(posting.title);
	return {
		title,
		titleNormalized: title.toLowerCase(),
		employerName: orNull(posting.employerName) ?? employerFallback,
		locationText: orNull(posting.locationText),
		workplaceType: posting.workplaceType,
		employmentType: orNull(posting.employmentType),
		salary: posting.salary,
		canonicalUrl: canonicalUrl(posting.url),
		descriptionMarkdown: posting.descriptionHtml === null ? null : sanitizedMarkdown(posting.descriptionHtml) || null,
		firstPublishedAt: posting.firstPublishedAt === null ? null : new Date(posting.firstPublishedAt),
	};
}

/** The fields whose change is a `posting_changed`, in a fixed order. */
export const CONTENT_FIELDS = ["title", "location", "workplace", "employment", "salary", "description"] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];
export type FieldHashes = Record<ContentField, string>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A hash per content field of the normalized text: HTML, whitespace and tracking-only
 * differences hash the same, any change to the words does not.
 */
export function fieldHashes(posting: NormalizedPosting): FieldHashes {
	return {
		title: sha256(posting.title),
		location: sha256(posting.locationText ?? ""),
		workplace: sha256(posting.workplaceType ?? ""),
		employment: sha256(posting.employmentType ?? ""),
		salary: sha256(JSON.stringify(posting.salary)),
		description: sha256(squash(posting.descriptionMarkdown ?? "")),
	};
}

export function contentHash(hashes: FieldHashes): string {
	return sha256(CONTENT_FIELDS.map((field) => hashes[field]).join(":"));
}

/** Exact identity keys, strongest first (§6): Source posting, same-Employer requisition, canonical URL. */
export function identityKeys(posting: SourcePosting, url: string): { key: string; kind: IdentityKind }[] {
	const board = `${posting.source}:${posting.boardToken.toLowerCase()}`;
	return [
		{ key: `posting:${board}:${posting.nativeId}`, kind: "posting" as const },
		...(posting.requisitionId
			? [{ key: `requisition:${board}:${posting.requisitionId}`, kind: "requisition" as const }]
			: []),
		{ key: `url:${url}`, kind: "url" as const },
	];
}
export type IdentityKind = "posting" | "requisition" | "url";
