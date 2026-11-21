import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { AlertTriangle, Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { Tabs } from "radix-ui";
import type * as React from "react";
import { type FormEvent, useState } from "react";
import type { AppRouter } from "../../api/router";
import {
	ENTRY_KIND_INFO,
	type EntryKind,
	FACT_KINDS,
	type FactKindName,
	type FactScope,
	factKind,
	kindsFor,
} from "../../packages/candidate/kinds";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { DocumentsCard, useDocuments } from "./documents";

type KnowledgeBase = inferRouterOutputs<AppRouter>["candidate"]["knowledgeBase"];
type Fact = KnowledgeBase["facts"][number];
type Entry = KnowledgeBase["entries"][number];
type Proposal = Parameters<ReturnType<typeof useKnowledgeBase>["propose"]["mutate"]>[0];

const ABOUT_YOU = ["name", "email", "phone", "location"] as const satisfies FactKindName[];
const ENTRY_TABS: EntryKind[] = ["role", "education", "project", "story", "certification"];
const fieldClass =
	"w-full min-w-0 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function useKnowledgeBase() {
	const queryClient = useQueryClient();
	const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.candidate.knowledgeBase.queryKey() });
	return {
		query: useQuery(trpc.candidate.knowledgeBase.queryOptions()),
		propose: useMutation(trpc.candidate.propose.mutationOptions({ onSuccess: invalidate })),
		removeFact: useMutation(trpc.candidate.removeFact.mutationOptions({ onSuccess: invalidate })),
		removeEntry: useMutation(trpc.candidate.removeEntry.mutationOptions({ onSuccess: invalidate })),
	};
}

/** The Candidate screen (§16, PRD §87): the About you form and the profile editor over the Knowledge Base. */
export function CandidateScreen() {
	const { query } = useKnowledgeBase();
	const kb = query.data;
	const count = (kind: EntryKind) => kb?.entries.filter((entry) => entry.kind === kind).length ?? 0;
	const skills = kb?.facts.filter((fact) => fact.kind === "skill") ?? [];

	return (
		<div className="max-w-4xl space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Candidate</h1>
				<p className="text-sm text-muted-foreground">
					Everything here is saved as your own statement and shapes future Applications. Add to it any time.
				</p>
			</div>
			<Tabs.Root defaultValue="profile" className="space-y-5">
				<Tabs.List aria-label="Candidate sections" className="flex flex-wrap gap-1 border-b">
					<Tab value="profile" label="Profile" />
					{ENTRY_TABS.map((kind) => (
						<Tab key={kind} value={kind} label={ENTRY_KIND_INFO[kind].plural} count={count(kind)} />
					))}
					<Tab value="skills" label="Skills" count={skills.length} />
				</Tabs.List>
				{!kb ? (
					<p className="text-sm text-muted-foreground">{query.isError ? "Could not load your profile." : "Loading…"}</p>
				) : (
					<>
						<Tabs.Content value="profile" className="space-y-5">
							<DocumentsCard />
							<CheckTheEssentials kb={kb} />
							<AboutYou facts={kb.facts} />
							<CandidateDetails facts={kb.facts} />
						</Tabs.Content>
						{ENTRY_TABS.map((kind) => (
							<Tabs.Content key={kind} value={kind}>
								<EntryList kind={kind} entries={kb.entries} />
							</Tabs.Content>
						))}
						<Tabs.Content value="skills">
							<Card>
								<CardHeader>
									<CardTitle>Skills</CardTitle>
									<CardDescription>Technologies, tools, methods and domains you work in.</CardDescription>
								</CardHeader>
								<CardContent className="space-y-3">
									<FactList facts={skills} empty="No skills yet." />
									<AddFact scope="candidate" kinds={["skill"]} />
								</CardContent>
							</Card>
						</Tabs.Content>
					</>
				)}
			</Tabs.Root>
		</div>
	);
}

function Tab({ value, label, count = 0 }: { value: string; label: string; count?: number }) {
	return (
		<Tabs.Trigger
			value={value}
			className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground"
		>
			{label}
			{count > 0 && (
				<span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
					<span className="sr-only">, </span>
					{count}
				</span>
			)}
		</Tabs.Trigger>
	);
}

const ESSENTIALS_DISMISSED = "jobaculator.essentials-dismissed";

/**
 * Check the essentials (#21): the Authoritative Facts documents established and the
 * unresolved conflicts between authoritative values, to correct in place. Optional and
 * dismissible; it comes back only when something new appears in it.
 */
function CheckTheEssentials({ kb }: { kb: KnowledgeBase }) {
	const [dismissed, setDismissed] = useState<string[]>(() => {
		try {
			return JSON.parse(localStorage.getItem(ESSENTIALS_DISMISSED) ?? "[]") as string[];
		} catch {
			return [];
		}
	});
	const essential = (fact: Fact) =>
		(fact.authoritative && !fact.verified) || (factKind(fact.kind).authoritative && fact.conflictsWith.length > 0);
	const groups = [
		{ id: "candidate", title: "About you", facts: kb.facts.filter(essential) },
		...kb.entries.map((entry) => ({ id: entry.id, title: entryTitle(entry), facts: entry.facts.filter(essential) })),
	].filter((group) => group.facts.length > 0);
	const ids = groups.flatMap((group) => group.facts.map((fact) => fact.id));
	if (ids.every((id) => dismissed.includes(id))) return null;

	function dismiss() {
		localStorage.setItem(ESSENTIALS_DISMISSED, JSON.stringify(ids));
		setDismissed(ids);
	}

	return (
		<Card className="border-primary/40">
			<CardHeader className="flex-row items-start justify-between gap-4">
				<div className="space-y-1">
					<CardTitle>Check the essentials</CardTitle>
					<CardDescription>
						Your documents gave these details, and every Application uses them exactly as written. Correct anything that
						is wrong; there is nothing to confirm.
					</CardDescription>
				</div>
				<Button variant="ghost" size="sm" className="text-muted-foreground" onClick={dismiss}>
					<X /> Dismiss
				</Button>
			</CardHeader>
			<CardContent className="space-y-4">
				{groups.map((group) => (
					<div key={group.id} className="space-y-1.5">
						<div className="text-xs font-medium text-muted-foreground">{group.title}</div>
						<FactList facts={group.facts} empty="" />
					</div>
				))}
			</CardContent>
		</Card>
	);
}

/** Contact identity and general location (#21): enough for a Candidate with no documents. */
function AboutYou({ facts }: { facts: Fact[] }) {
	const { propose } = useKnowledgeBase();
	const [saved, setSaved] = useState(false);
	const current = (kind: string) => facts.filter((fact) => fact.kind === kind);

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const changed = ABOUT_YOU.flatMap((kind) => {
			const value = String(form.get(kind) ?? "").trim();
			const existing = current(kind);
			return value && !(existing.length === 1 && existing[0]?.value === value) ? [{ kind, value }] : [];
		});
		setSaved(false);
		if (changed.length === 0) return setSaved(true);
		propose.mutate({ via: "about_you", facts: changed }, { onSuccess: () => setSaved(true) });
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>About you</CardTitle>
				<CardDescription>
					Your name and email are needed before any Application is prepared. Employers see them exactly as written.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form className="space-y-4" onSubmit={onSubmit} onChange={() => setSaved(false)}>
					<div className="grid grid-cols-2 gap-4">
						{ABOUT_YOU.map((kind) => {
							const values = current(kind);
							return (
								<div key={kind} className="space-y-2">
									<Label htmlFor={`about-${kind}`}>{FACT_KINDS[kind].label}</Label>
									<Input
										id={`about-${kind}`}
										name={kind}
										type={FACT_KINDS[kind].input === "text" ? "text" : FACT_KINDS[kind].input}
										defaultValue={values.length === 1 ? values[0]?.value : ""}
										placeholder={values.length > 1 ? values.map((fact) => fact.value).join(" or ") : undefined}
										autoComplete={{ name: "name", email: "email", phone: "tel", location: "address-level2" }[kind]}
									/>
									{values.length > 1 && (
										<p className="flex items-center gap-1 text-xs text-warning-foreground">
											<AlertTriangle className="size-3" /> Your documents disagree. Enter the right one.
										</p>
									)}
								</div>
							);
						})}
					</div>
					<div className="flex items-center gap-3">
						<Button type="submit" disabled={propose.isPending}>
							{propose.isPending ? "Saving…" : "Save"}
						</Button>
						{saved && <span className="text-sm text-muted-foreground">Saved.</span>}
						<ErrorText error={propose.error} />
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

function CandidateDetails({ facts }: { facts: Fact[] }) {
	const shown = (kind: string) => !(ABOUT_YOU as readonly string[]).includes(kind) && kind !== "skill";
	return (
		<Card>
			<CardHeader>
				<CardTitle>More about you</CardTitle>
				<CardDescription>Legal name, work authorization, availability, links and anything else.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<FactList facts={facts.filter((fact) => shown(fact.kind))} empty="Nothing else yet." />
				<AddFact scope="candidate" kinds={kindsFor("candidate").filter(shown)} />
			</CardContent>
		</Card>
	);
}

function entryTitle(entry: Entry): string {
	const values = ENTRY_KIND_INFO[entry.kind].identity.flatMap(
		(kind) => entry.facts.find((fact) => fact.kind === kind)?.value ?? [],
	);
	return values.join(" · ") || `Untitled ${ENTRY_KIND_INFO[entry.kind].label.toLowerCase()}`;
}

function entryDates(entry: Entry): string | null {
	const value = (kind: string) => entry.facts.find((fact) => fact.kind === kind)?.value;
	const start = value("start_date") ?? value("issued_date");
	const end = value("end_date") ?? value("expiry_date");
	if (!start && !end) return null;
	return [start ?? "?", end].filter(Boolean).join(" – ");
}

function EntryList({ kind, entries }: { kind: EntryKind; entries: Entry[] }) {
	const info = ENTRY_KIND_INFO[kind];
	const ofKind = entries.filter((entry) => entry.kind === kind);
	// Stories (and the like) may sit under a role or project, one level deep.
	const parents = entries.filter((entry) => entry.parentId === null && entry.kind !== kind);
	return (
		<div className="space-y-4">
			{ofKind.length === 0 && <p className="text-sm text-muted-foreground">No {info.plural.toLowerCase()} yet.</p>}
			{ofKind.map((entry) => (
				<EntryCard
					key={entry.id}
					entry={entry}
					parent={entries.find((p) => p.id === entry.parentId)}
					nested={entries.filter((child) => child.parentId === entry.id)}
				/>
			))}
			<NewEntry kind={kind} parents={kind === "story" ? parents : []} />
		</div>
	);
}

function EntryCard({ entry, parent, nested }: { entry: Entry; parent?: Entry; nested: Entry[] }) {
	const { removeEntry } = useKnowledgeBase();
	const dates = entryDates(entry);
	return (
		<Card>
			<CardHeader className="flex-row items-start justify-between gap-4">
				<div className="space-y-1">
					<CardTitle>{entryTitle(entry)}</CardTitle>
					<CardDescription>
						{[dates, parent && `Under ${entryTitle(parent)}`].filter(Boolean).join(" · ") || null}
					</CardDescription>
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground"
					disabled={removeEntry.isPending}
					onClick={() => {
						const extra = nested.length > 0 ? ` and the ${nested.length} item(s) under it` : "";
						if (window.confirm(`Delete “${entryTitle(entry)}”${extra}?`)) removeEntry.mutate({ entryId: entry.id });
					}}
				>
					<Trash2 /> Delete
				</Button>
			</CardHeader>
			<CardContent className="space-y-3">
				<FactList facts={entry.facts} empty="No details yet." />
				{nested.length > 0 && (
					<p className="text-xs text-muted-foreground">
						Stories: {nested.map((child) => entryTitle(child)).join(", ")}
					</p>
				)}
				<AddFact scope={entry.kind} kinds={kindsFor(entry.kind)} entryId={entry.id} />
			</CardContent>
		</Card>
	);
}

function NewEntry({ kind, parents }: { kind: EntryKind; parents: Entry[] }) {
	const { propose } = useKnowledgeBase();
	const [open, setOpen] = useState(false);
	const info = ENTRY_KIND_INFO[kind];
	const fields: FactKindName[] = [
		...info.identity,
		...kindsFor(kind).filter((k) => !info.identity.includes(k) && factKind(k).input === "date"),
	];
	if (kind === "story") fields.push("situation", "action", "result");

	if (!open) {
		return (
			<Button variant="outline" onClick={() => setOpen(true)}>
				<Plus /> Add {info.label.toLowerCase()}
			</Button>
		);
	}

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const parentId = String(form.get("parent") ?? "");
		const entry = { ref: "new", kind, ...(parentId ? { parent: { id: parentId } } : {}) };
		const facts = fields.flatMap((k) => {
			const value = String(form.get(k) ?? "").trim();
			return value ? [{ kind: k, value, entry }] : [];
		});
		if (facts.length === 0) return;
		propose.mutate({ via: "profile_editor", facts }, { onSuccess: () => setOpen(false) });
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>New {info.label.toLowerCase()}</CardTitle>
			</CardHeader>
			<CardContent>
				<form className="space-y-4" onSubmit={onSubmit}>
					<div className="grid grid-cols-2 gap-4">
						{fields.map((k) => (
							<div key={k} className={cn("space-y-2", factKind(k).input === "textarea" && "col-span-2")}>
								<Label htmlFor={`new-${kind}-${k}`}>{factKind(k).label}</Label>
								<ValueInput id={`new-${kind}-${k}`} name={k} kind={k} />
							</div>
						))}
						{parents.length > 0 && (
							<div className="space-y-2">
								<Label htmlFor={`new-${kind}-parent`}>Under (optional)</Label>
								<select id={`new-${kind}-parent`} name="parent" className={fieldClass} defaultValue="">
									<option value="">Nothing: it stands alone</option>
									{parents.map((p) => (
										<option key={p.id} value={p.id}>
											{entryTitle(p)}
										</option>
									))}
								</select>
							</div>
						)}
					</div>
					<div className="flex items-center gap-3">
						<Button type="submit" disabled={propose.isPending}>
							Add
						</Button>
						<Button type="button" variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<ErrorText error={propose.error} />
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

function FactList({ facts, empty }: { facts: Fact[]; empty: string }) {
	if (facts.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
	return (
		<ul className="divide-y rounded-md border">
			{facts.map((fact) => (
				<FactRow key={fact.id} fact={fact} />
			))}
		</ul>
	);
}

const PROVENANCE: Record<Fact["provenance"], string> = {
	USER_EXPLICIT: "You said",
	DOCUMENT_EXPLICIT: "From a document",
	MULTI_SOURCE_SUPPORTED: "From several documents",
	AI_INFERRED: "Inferred",
};

/** Where a Fact came from, naming its documents once they are known. */
function useProvenance(fact: Fact): string {
	const documents = useDocuments().data ?? [];
	const names = [
		...new Set(
			fact.sources.flatMap((source) =>
				source.kind === "document" ? (documents.find((d) => d.id === source.documentId)?.filename ?? []) : [],
			),
		),
	];
	if (fact.provenance === "USER_EXPLICIT" || names.length === 0) return PROVENANCE[fact.provenance];
	return `${fact.provenance === "AI_INFERRED" ? "Inferred from" : "From"} ${names.join(" and ")}`;
}

function FactRow({ fact }: { fact: Fact }) {
	const { propose, removeFact } = useKnowledgeBase();
	const [editing, setEditing] = useState(false);
	const kind = factKind(fact.kind);
	const provenance = useProvenance(fact);

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = String(new FormData(event.currentTarget).get("value") ?? "").trim();
		// Saving a conflicting value unchanged confirms it, which settles the conflict.
		if (!value || (value === fact.value && fact.conflictsWith.length === 0)) return setEditing(false);
		const proposal: Proposal = { via: "profile_editor", facts: [{ kind: fact.kind, value, factId: fact.id }] };
		propose.mutate(proposal, { onSuccess: () => setEditing(false) });
	}

	return (
		<li className="flex items-start gap-3 px-3 py-2.5 text-sm">
			<div className="w-36 shrink-0 pt-1 text-muted-foreground">{kind.label}</div>
			{editing ? (
				<form className="flex flex-1 flex-col gap-2" onSubmit={onSubmit}>
					<ValueInput name="value" kind={fact.kind} defaultValue={fact.value} autoFocus aria-label={kind.label} />
					<div className="flex items-center gap-2">
						<Button type="submit" size="sm" disabled={propose.isPending}>
							Save
						</Button>
						<Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<ErrorText error={propose.error} />
					</div>
				</form>
			) : (
				<>
					<div className="min-w-0 flex-1 space-y-1 pt-1">
						<div className="whitespace-pre-wrap break-words">{fact.value}</div>
						<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<span>{provenance}</span>
							{fact.authoritative && (
								<span className="flex items-center gap-1" title="Used exactly as stated; only you can change it">
									<Lock className="size-3" /> Authoritative
								</span>
							)}
							{fact.conflictsWith.length > 0 && (
								<span className="flex items-center gap-1 text-warning-foreground">
									<AlertTriangle className="size-3" /> Disagrees with another value. Edit the right one to settle it.
								</span>
							)}
						</div>
					</div>
					<div className="flex shrink-0 gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="size-8 p-0"
							aria-label={`Edit ${kind.label}`}
							onClick={() => setEditing(true)}
						>
							<Pencil />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="size-8 p-0"
							aria-label={`Delete ${kind.label}`}
							disabled={removeFact.isPending}
							onClick={() => removeFact.mutate({ factId: fact.id })}
						>
							<Trash2 />
						</Button>
					</div>
				</>
			)}
		</li>
	);
}

function AddFact({ scope, kinds, entryId }: { scope: FactScope; kinds: FactKindName[]; entryId?: string }) {
	const { propose } = useKnowledgeBase();
	const [kind, setKind] = useState<FactKindName>(kinds[0] ?? "other");
	const [value, setValue] = useState("");
	const id = `add-${entryId ?? scope}`;

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!value.trim()) return;
		propose.mutate(
			{ via: "profile_editor", facts: [{ kind, value: value.trim(), ...(entryId ? { entry: { id: entryId } } : {}) }] },
			{ onSuccess: () => setValue("") },
		);
	}

	return (
		<form className="space-y-1.5" onSubmit={onSubmit}>
			<div className="flex items-start gap-2">
				{kinds.length > 1 && (
					<select
						aria-label="Kind of detail"
						className={cn(fieldClass, "w-44 shrink-0")}
						value={kind}
						onChange={(event) => setKind(event.target.value as FactKindName)}
					>
						{kinds.map((k) => (
							<option key={k} value={k}>
								{factKind(k).label}
							</option>
						))}
					</select>
				)}
				<ValueInput
					id={id}
					kind={kind}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					aria-label={`New ${factKind(kind).label.toLowerCase()}`}
					placeholder={kinds.length > 1 ? undefined : `Add a ${factKind(kind).label.toLowerCase()}`}
				/>
				<Button type="submit" variant="outline" disabled={propose.isPending || !value.trim()}>
					<Plus /> Add
				</Button>
			</div>
			<ErrorText error={propose.error} />
		</form>
	);
}

function ValueInput({
	kind,
	...props
}: { kind: string } & React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
	const input = factKind(kind).input;
	if (input === "textarea") return <textarea rows={3} className={fieldClass} {...props} />;
	// Dates may be partial (2021, 2021-03), so they are typed as text.
	const placeholder = input === "date" ? (kind === "end_date" ? "YYYY-MM or present" : "YYYY-MM") : undefined;
	return (
		<Input
			type={input === "date" || input === "text" ? "text" : input}
			placeholder={placeholder}
			{...(props as React.InputHTMLAttributes<HTMLInputElement>)}
		/>
	);
}

function ErrorText({ error }: { error: { message: string } | null }) {
	if (!error) return null;
	return (
		<p role="alert" className="text-sm text-destructive">
			{error.message}
		</p>
	);
}
