import { z } from "zod";

/**
 * The fact-kind registry (#10): which kinds of Candidate Fact exist, where each sits,
 * how its values are validated and normalized, and whether it is Authoritative. The
 * kind is a text column, so adding a kind here needs no migration. Pure, so the SPA
 * shares it with the write path.
 */

export const ENTRY_KINDS = ["role", "education", "project", "story", "certification"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** Where a Fact sits: on the Candidate itself, or under an Entry of one of these kinds. */
export type FactScope = "candidate" | EntryKind;

/** PRD §9. Derived from a Fact's sources on every write; the Candidate never manages it. */
export type Provenance = "USER_EXPLICIT" | "DOCUMENT_EXPLICIT" | "MULTI_SOURCE_SUPPORTED" | "AI_INFERRED";

export type FactKind = {
	label: string;
	scopes: readonly FactScope[];
	/** `one`: a single value per scope, so a different value contradicts it. `many`: a list. */
	cardinality: "one" | "many";
	/** Only the Candidate may establish or change it (their own documents count). */
	authoritative: boolean;
	schema: z.ZodType<string>;
	/** The comparison key: values with equal keys are the same claim. */
	normalize: (value: string) => string;
	/** For precision-aware kinds: the more precise of two compatible values, or null if they differ. */
	refine?: (a: string, b: string) => string | null;
	input: "text" | "textarea" | "date" | "email" | "tel" | "url";
};

const collapse = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ");
const plainText = (value: string) =>
	collapse(value)
		.toLowerCase()
		.replace(/[.;:,!]+$/, "");
/** A person's name keeps every word and mark: "Dana Co" and "Dana" are different people. */
const personName = (value: string) => collapse(value).toLowerCase().replaceAll("’", "'");
const LEGAL_SUFFIX = /\s+(inc|incorporated|llc|llp|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa)$/;
/** An organization's name drops punctuation, a leading "the" and legal suffixes: "Acme, Inc." is "ACME". */
function organization(value: string): string {
	let key = plainText(value).replace(/[.,]/g, "").replace(/^the /, "");
	while (LEGAL_SUFFIX.test(key)) key = key.replace(LEGAL_SUFFIX, "");
	return key;
}
const digits = (value: string) => value.replace(/\D/g, "");
const url = (value: string) =>
	collapse(value)
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\/+$/, "");

const text = z.string().trim().min(1).max(4000);
const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const date = z.string().trim().regex(DATE, "use YYYY, YYYY-MM or YYYY-MM-DD");
const endDate = z
	.string()
	.trim()
	.transform((value) => (value.toLowerCase() === "present" ? "present" : value))
	.refine((value) => value === "present" || DATE.test(value), "use YYYY, YYYY-MM, YYYY-MM-DD or present");

/** "2021" and "2021-03" agree at different precision; the more precise wins. */
function refineDate(a: string, b: string): string | null {
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return long === short || long.startsWith(`${short}-`) ? long : null;
}

const ENTRIES_WITH_DATES = ["role", "education", "project"] as const;

function kind(definition: Omit<FactKind, "input" | "normalize"> & Partial<Pick<FactKind, "input" | "normalize">>) {
	return { input: "text", normalize: plainText, ...definition } satisfies FactKind;
}

export const FACT_KINDS = {
	// On the Candidate. Contact identity (name, email) is Authoritative and can never be guessed (#21).
	name: kind({
		label: "Name",
		scopes: ["candidate"],
		cardinality: "one",
		authoritative: true,
		schema: text,
		normalize: personName,
	}),
	legal_name: kind({
		label: "Legal name",
		scopes: ["candidate"],
		cardinality: "one",
		authoritative: true,
		schema: text,
		normalize: personName,
	}),
	email: kind({
		label: "Email",
		scopes: ["candidate"],
		cardinality: "one",
		authoritative: true,
		schema: z.string().trim().pipe(z.email()),
		input: "email",
	}),
	phone: kind({
		label: "Phone",
		scopes: ["candidate"],
		cardinality: "one",
		authoritative: true,
		schema: text.regex(/\d{3}/, "enter a phone number"),
		normalize: digits,
		input: "tel",
	}),
	location: kind({
		label: "Location",
		scopes: ["candidate", "role"],
		cardinality: "one",
		authoritative: false,
		schema: text,
	}),
	link: kind({
		label: "Link",
		scopes: ["candidate", "project"],
		cardinality: "many",
		authoritative: false,
		schema: text,
		normalize: url,
		input: "url",
	}),
	skill: kind({ label: "Skill", scopes: ["candidate"], cardinality: "many", authoritative: false, schema: text }),
	work_authorization: kind({
		label: "Work authorization",
		scopes: ["candidate"],
		cardinality: "one",
		authoritative: true,
		schema: text,
	}),
	clearance: kind({
		label: "Security clearance",
		scopes: ["candidate"],
		cardinality: "one",
		authoritative: true,
		schema: text,
	}),
	notice_period: kind({
		label: "Notice period",
		scopes: ["candidate"],
		cardinality: "one",
		authoritative: true,
		schema: text,
	}),
	earliest_start: kind({
		label: "Earliest start date",
		scopes: ["candidate"],
		cardinality: "one",
		authoritative: true,
		schema: date,
		refine: refineDate,
		input: "date",
	}),

	// Under Entries.
	employer: kind({
		label: "Employer",
		scopes: ["role"],
		cardinality: "one",
		authoritative: true,
		schema: text,
		normalize: organization,
	}),
	title: kind({ label: "Title", scopes: ["role"], cardinality: "one", authoritative: true, schema: text }),
	start_date: kind({
		label: "Start date",
		scopes: ENTRIES_WITH_DATES,
		cardinality: "one",
		authoritative: true,
		schema: date,
		refine: refineDate,
		input: "date",
	}),
	end_date: kind({
		label: "End date",
		scopes: ENTRIES_WITH_DATES,
		cardinality: "one",
		authoritative: true,
		schema: endDate,
		refine: refineDate,
		input: "date",
	}),
	accomplishment: kind({
		label: "Accomplishment",
		scopes: ["role", "project"],
		cardinality: "many",
		authoritative: false,
		schema: text,
		input: "textarea",
	}),
	responsibility: kind({
		label: "Responsibility",
		scopes: ["role"],
		cardinality: "many",
		authoritative: false,
		schema: text,
		input: "textarea",
	}),
	technology: kind({
		label: "Technology",
		scopes: ["role", "project"],
		cardinality: "many",
		authoritative: false,
		schema: text,
	}),
	institution: kind({
		label: "Institution",
		scopes: ["education"],
		cardinality: "one",
		authoritative: true,
		schema: text,
		normalize: organization,
	}),
	degree: kind({ label: "Degree", scopes: ["education"], cardinality: "one", authoritative: true, schema: text }),
	field_of_study: kind({
		label: "Field of study",
		scopes: ["education"],
		cardinality: "one",
		authoritative: true,
		schema: text,
	}),
	coursework: kind({
		label: "Coursework",
		scopes: ["education"],
		cardinality: "many",
		authoritative: false,
		schema: text,
	}),
	achievement: kind({
		label: "Achievement",
		scopes: ["education"],
		cardinality: "many",
		authoritative: false,
		schema: text,
		input: "textarea",
	}),
	project_name: kind({
		label: "Project name",
		scopes: ["project"],
		cardinality: "one",
		authoritative: false,
		schema: text,
	}),
	description: kind({
		label: "Description",
		scopes: ["project"],
		cardinality: "one",
		authoritative: false,
		schema: text,
		input: "textarea",
	}),
	story_title: kind({
		label: "Story title",
		scopes: ["story"],
		cardinality: "one",
		authoritative: false,
		schema: text,
	}),
	situation: kind({
		label: "Situation",
		scopes: ["story"],
		cardinality: "one",
		authoritative: false,
		schema: text,
		input: "textarea",
	}),
	action: kind({
		label: "Action",
		scopes: ["story"],
		cardinality: "one",
		authoritative: false,
		schema: text,
		input: "textarea",
	}),
	result: kind({
		label: "Result",
		scopes: ["story"],
		cardinality: "one",
		authoritative: false,
		schema: text,
		input: "textarea",
	}),
	theme: kind({ label: "Theme", scopes: ["story"], cardinality: "many", authoritative: false, schema: text }),
	certification: kind({
		label: "Certification",
		scopes: ["certification"],
		cardinality: "one",
		authoritative: true,
		schema: text,
	}),
	issuer: kind({
		label: "Issuer",
		scopes: ["certification"],
		cardinality: "one",
		authoritative: true,
		schema: text,
		normalize: organization,
	}),
	issued_date: kind({
		label: "Issued",
		scopes: ["certification"],
		cardinality: "one",
		authoritative: true,
		schema: date,
		refine: refineDate,
		input: "date",
	}),
	expiry_date: kind({
		label: "Expires",
		scopes: ["certification"],
		cardinality: "one",
		authoritative: true,
		schema: date,
		refine: refineDate,
		input: "date",
	}),

	/** The fallback for a claim no other kind fits, anywhere. */
	other: kind({
		label: "Other",
		scopes: ["candidate", ...ENTRY_KINDS],
		cardinality: "many",
		authoritative: false,
		schema: text,
		input: "textarea",
	}),
} satisfies Record<string, FactKind>;

export type FactKindName = keyof typeof FACT_KINDS;

export const ENTRY_KIND_INFO: Record<EntryKind, { label: string; plural: string; identity: readonly FactKindName[] }> =
	{
		role: { label: "Role", plural: "Experience", identity: ["employer", "title"] },
		education: { label: "Education", plural: "Education", identity: ["institution", "degree"] },
		project: { label: "Project", plural: "Projects", identity: ["project_name"] },
		story: { label: "Story", plural: "Stories", identity: ["story_title"] },
		certification: { label: "Certification", plural: "Certifications", identity: ["certification"] },
	};

export function isFactKindName(name: string): name is FactKindName {
	return Object.hasOwn(FACT_KINDS, name);
}

export function factKind(name: string): FactKind {
	if (!isFactKindName(name)) throw new Error(`unknown fact kind: ${name}`);
	return FACT_KINDS[name];
}

/** The fact kinds a scope can hold, in registry order. */
export function kindsFor(scope: FactScope): FactKindName[] {
	return (Object.keys(FACT_KINDS) as FactKindName[]).filter((name) =>
		(FACT_KINDS[name].scopes as readonly FactScope[]).includes(scope),
	);
}

/**
 * Whether two values of a kind are the same claim, and if so the value they agree on
 * (`a` unless `b` is more precise). Null means they differ.
 */
export function agreedValue(kindName: string, a: string, b: string): string | null {
	const k = factKind(kindName);
	if (k.refine) return k.refine(k.normalize(a), k.normalize(b));
	return k.normalize(a) === k.normalize(b) ? a : null;
}
