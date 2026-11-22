import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { Tabs } from "radix-ui";
import type { ApplicationAnswer, QuestionClass, ResumeDocument, Strategy } from "../../packages/generation/index";
import { TIER_LABELS } from "../../packages/hunts/criteria";
import type { DecisiveReason, DimensionJudgement } from "../../packages/matching/index";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { LATITUDE_COPY } from "../lib/hunt-copy";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { STATUS_LABELS } from "./applications";

const POLL_MS = 15_000;
const time = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const REASON_COPY: Record<DecisiveReason, string> = {
	role_unacceptable: "The role is one this Hunt rules out.",
	location_unacceptable: "The location is one this Hunt rules out.",
	pay_below_floor: "The pay is below this Hunt's floor.",
	experience_beyond_stretch: "The required experience is beyond this Hunt's stretch.",
	auto_policy: "Qualified, so this Hunt applies automatically.",
};
const DIMENSION_LABELS: Record<DimensionJudgement["dimension"], string> = {
	role: "Role",
	location: "Location",
	pay: "Pay",
	experience: "Experience",
};

/** Application detail (§16): Why, Job Snapshot, Resume and Answers; Cover letter and Execution follow. */
export function ApplicationScreen() {
	const { applicationId } = useParams({ from: "/app/applications/$applicationId" });
	const query = useQuery({ ...trpc.applications.get.queryOptions({ id: applicationId }), refetchInterval: POLL_MS });

	if (query.isError) return <p className="text-sm text-destructive">This Application could not be loaded.</p>;
	if (!query.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
	const a = query.data;
	const pkg = a.package;
	const status = a.status === "PREPARING" && !a.preparing ? "Queued" : STATUS_LABELS[a.status];

	return (
		<div className="max-w-5xl space-y-6">
			<div className="space-y-1">
				<Link to="/applications" className="text-xs text-muted-foreground hover:underline">
					Applications /
				</Link>
				<div className="flex flex-wrap items-center gap-3">
					<h1 className="text-2xl font-semibold tracking-tight">{a.title}</h1>
					<span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold tracking-wide text-primary">
						{status}
					</span>
				</div>
				<p className="text-sm text-muted-foreground">
					{a.employerName} · Fit {a.fit}
					{a.drivingHunt && (
						<>
							{" · "}
							<Link to="/hunts/$huntId" params={{ huntId: a.drivingHunt.id }} className="hover:underline">
								{a.drivingHunt.name}
							</Link>
						</>
					)}
				</p>
				{pkg?.suspended && (
					<p role="status" className="rounded-md bg-warning px-3 py-2 text-sm text-warning-foreground">
						Preparation paused after the AI provider failed the same way several times. Your progress is kept; it picks
						up again when you change an AI key or AI setting.
					</p>
				)}
			</div>

			<Tabs.Root defaultValue="why" className="space-y-5">
				<Tabs.List aria-label="Application sections" className="flex flex-wrap gap-1 border-b">
					<Tab value="why" label="Why" />
					<Tab value="snapshot" label="Job Snapshot" />
					<Tab value="resume" label="Resume" />
					<Tab value="answers" label="Answers" />
				</Tabs.List>
				<Tabs.Content value="why" className="space-y-5">
					<MatchCard evaluation={a.evaluation} />
					{pkg?.strategy ? <StrategyCard strategy={pkg.strategy} /> : <Pending what="The Strategy" />}
				</Tabs.Content>
				<Tabs.Content value="snapshot">
					{pkg ? <SnapshotCard snapshot={pkg.jobSnapshot} /> : <Pending what="The Job Snapshot" />}
				</Tabs.Content>
				<Tabs.Content value="resume">
					{pkg?.resume ? (
						<ResumeCard applicationId={a.id} resume={pkg.resume} pages={pkg.resumePages} />
					) : (
						<Pending what="The tailored resume" />
					)}
				</Tabs.Content>
				<Tabs.Content value="answers">
					{pkg?.answers ? <AnswersCard answers={pkg.answers} /> : <Pending what="The answers" />}
				</Tabs.Content>
			</Tabs.Root>
		</div>
	);
}

function Tab({ value, label }: { value: string; label: string }) {
	return (
		<Tabs.Trigger
			value={value}
			className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground"
		>
			{label}
		</Tabs.Trigger>
	);
}

function Pending({ what }: { what: string }) {
	return <p className="text-sm text-muted-foreground">{what} appears here once preparation reaches it.</p>;
}

type Evaluation = { fit: number; reason: DecisiveReason; dimensions: DimensionJudgement[]; evaluatedAt: string };

function MatchCard({ evaluation }: { evaluation: Evaluation }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Match</CardTitle>
				<CardDescription>
					Fit {evaluation.fit}. {REASON_COPY[evaluation.reason]} Judged {time.format(new Date(evaluation.evaluatedAt))}.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<dl className="divide-y text-sm">
					{evaluation.dimensions.map((d) => (
						<div key={d.dimension} className="grid grid-cols-[8rem_7rem_1fr] gap-3 py-2">
							<dt className="font-medium">{DIMENSION_LABELS[d.dimension]}</dt>
							<dd>
								{d.tier ? TIER_LABELS[d.tier] : "Unknown"}
								{d.provenance === "inferred" && <span className="text-muted-foreground"> (inferred)</span>}
							</dd>
							<dd className="text-muted-foreground">{d.detail}</dd>
						</div>
					))}
				</dl>
			</CardContent>
		</Card>
	);
}

function StrategyCard({ strategy }: { strategy: Strategy }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Strategy</CardTitle>
				<CardDescription>
					The writing plan for this Application, at {LATITUDE_COPY[strategy.latitude].label} Creative Latitude.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5 text-sm">
				<section className="space-y-1">
					<h3 className="font-medium">Lead</h3>
					<p>{strategy.leadAngle}</p>
				</section>
				{strategy.themes.length > 0 && (
					<section className="space-y-1">
						<h3 className="font-medium">What the employer wants</h3>
						<ol className="list-decimal space-y-1 pl-5">
							{strategy.themes.map((t) => (
								<li key={t.theme}>
									{t.theme} <span className="text-muted-foreground">— {t.why}</span>
								</li>
							))}
						</ol>
					</section>
				)}
				{strategy.keywords.length > 0 && (
					<section className="space-y-1.5">
						<h3 className="font-medium">Keywords</h3>
						<ul className="flex flex-wrap gap-1.5">
							{strategy.keywords.map((k) => (
								<li
									key={k.keyword}
									title={k.transferable ? (k.rationale ?? undefined) : undefined}
									className={cn(
										"rounded-md border px-2 py-0.5 text-xs",
										k.transferable && "border-dashed text-muted-foreground",
									)}
								>
									{k.keyword}
									{k.transferable && " · transferable"}
								</li>
							))}
						</ul>
					</section>
				)}
				{strategy.framings.length > 0 && (
					<section className="space-y-1">
						<h3 className="font-medium">Framings</h3>
						<ul className="space-y-1">
							{strategy.framings.map((f) => (
								<li key={f.requirement}>
									<span className="font-medium">{f.requirement}:</span> {f.framing}
								</li>
							))}
						</ul>
					</section>
				)}
				<section className="space-y-1">
					<h3 className="font-medium">Cover letter angle</h3>
					<p>{strategy.coverLetterAngle}</p>
				</section>
			</CardContent>
		</Card>
	);
}

type Snapshot = {
	title: string;
	employerName: string;
	locationText: string | null;
	workplaceType: string | null;
	salary: { min: number | null; max: number | null; currency: string } | null;
	url: string;
	descriptionMarkdown: string | null;
	capturedAt: string;
};

function SnapshotCard({ snapshot }: { snapshot: Snapshot }) {
	const { salary } = snapshot;
	const money = (n: number | null) => (n === null ? "?" : n.toLocaleString());
	return (
		<Card>
			<CardHeader>
				<CardTitle>{snapshot.title}</CardTitle>
				<CardDescription>
					The posting as it read on {time.format(new Date(snapshot.capturedAt))}, kept unchanged with this Application.{" "}
					<a href={snapshot.url} target="_blank" rel="noopener noreferrer" className="underline">
						Open the live posting
					</a>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 text-sm">
				<dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
					<Field label="Employer" value={snapshot.employerName} />
					<Field label="Location" value={snapshot.locationText} />
					<Field label="Workplace" value={snapshot.workplaceType?.toLowerCase() ?? null} />
					<Field label="Pay" value={salary ? `${money(salary.min)} – ${money(salary.max)} ${salary.currency}` : null} />
				</dl>
				{/* Sanitized Markdown shown as text, never as posting HTML (§14). */}
				<div className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 leading-relaxed">
					{snapshot.descriptionMarkdown ?? "The posting has no description."}
				</div>
			</CardContent>
		</Card>
	);
}

function Field({ label, value }: { label: string; value: string | null }) {
	return (
		<div>
			<dt className="font-medium">{label}</dt>
			<dd className={value ? undefined : "text-muted-foreground"}>{value ?? "Not stated"}</dd>
		</div>
	);
}

function ResumeCard(props: { applicationId: string; resume: ResumeDocument; pages: number | null }) {
	const { resume, pages } = props;
	const dates = (start: string | null, end: string | null) => [start, end].filter(Boolean).join(" – ");
	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-1.5">
						<CardTitle>Tailored resume</CardTitle>
						<CardDescription>
							Modern template{pages ? `, ${pages} ${pages === 1 ? "page" : "pages"}` : ""}. Names, employers, titles,
							dates and education come straight from your profile.
						</CardDescription>
					</div>
					<Button asChild>
						<a href={`/api/applications/${props.applicationId}/resume.pdf`}>
							<Download />
							Download PDF
						</a>
					</Button>
				</div>
			</CardHeader>
			<CardContent>
				<article aria-label="Resume preview" className="space-y-4 rounded-md border p-6 text-sm">
					<header>
						<p className="text-xl font-bold">{resume.identity.name}</p>
						<p className="text-muted-foreground">
							{[resume.identity.email, resume.identity.phone, resume.identity.location, ...resume.identity.links]
								.filter(Boolean)
								.join(" · ")}
						</p>
					</header>
					{resume.summary && <p>{resume.summary.text}</p>}
					{resume.skills.length > 0 && (
						<ResumeSection title="Skills">
							{resume.skills.map((g) => (
								<p key={g.group}>
									<span className="font-semibold">{g.group}</span> {g.items.map((i) => i.text).join(" · ")}
								</p>
							))}
						</ResumeSection>
					)}
					{resume.experience.length > 0 && (
						<ResumeSection title="Experience">
							{resume.experience.map((e) => (
								<div key={e.entryId}>
									<p className="flex justify-between gap-3">
										<span className="font-semibold">{e.employer}</span>
										<span className="text-muted-foreground">{dates(e.start, e.end)}</span>
									</p>
									{e.title && <p>{e.title}</p>}
									<Bullets items={e.bullets} />
								</div>
							))}
						</ResumeSection>
					)}
					{resume.projects.length > 0 && (
						<ResumeSection title="Projects">
							{resume.projects.map((p) => (
								<div key={p.entryId}>
									<p className="font-semibold">{p.name}</p>
									<Bullets items={p.bullets} />
								</div>
							))}
						</ResumeSection>
					)}
					{resume.education.length > 0 && (
						<ResumeSection title="Education">
							{resume.education.map((ed) => (
								<div key={ed.entryId}>
									<p className="flex justify-between gap-3">
										<span className="font-semibold">{ed.school}</span>
										<span className="text-muted-foreground">{dates(ed.start, ed.end)}</span>
									</p>
									{ed.degree && <p>{ed.degree}</p>}
									<Bullets items={ed.bullets} />
								</div>
							))}
						</ResumeSection>
					)}
					{resume.certifications.length > 0 && (
						<ResumeSection title="Certifications">
							{resume.certifications.map((c) => (
								<p key={c.entryId} className="flex justify-between gap-3">
									<span>{[c.name, c.issuer].filter(Boolean).join(", ")}</span>
									<span className="text-muted-foreground">{c.issued}</span>
								</p>
							))}
						</ResumeSection>
					)}
				</article>
			</CardContent>
		</Card>
	);
}

function ResumeSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-2">
			<h3 className="font-bold text-primary">{title}</h3>
			{children}
		</section>
	);
}

function Bullets({ items }: { items: { text: string }[] }) {
	if (items.length === 0) return null;
	return (
		<ul className="mt-1 list-disc space-y-0.5 pl-5">
			{items.map((b) => (
				<li key={b.text}>{b.text}</li>
			))}
		</ul>
	);
}

const CLASS_LABELS: Record<QuestionClass, string> = {
	AUTHORITATIVE: "Authoritative",
	FACTUAL: "Factual",
	INFERABLE: "Inferred",
	PERSUASIVE: "Persuasive",
	PREFERENCE: "Preference",
	OPTIONAL_DISCLOSURE: "Optional disclosure",
	ASSESSMENT: "Assessment",
	UNKNOWN: "Unknown",
};
const VIA_COPY: Record<NonNullable<ApplicationAnswer["via"]>, string> = {
	POLICY: "From your standing answer",
	FACT: "From your profile",
	DECLINE: "Declined",
	MODEL: "Written for this posting",
};

/** The Application Answers (§9): each with its class and the facts, policies or Hunt it rests on. */
function AnswersCard({ answers }: { answers: (ApplicationAnswer & { sourceLabels: string[] })[] }) {
	const needs = answers.filter((a) => a.escalation).length;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Answers</CardTitle>
				<CardDescription>
					The answers to this posting's application questions.{" "}
					{needs > 0
						? `${needs} required ${needs === 1 ? "question needs" : "questions need"} you.`
						: "Optional questions with nothing to go on stay blank."}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<ol className="divide-y text-sm">
					{answers.map((a) => (
						<li key={a.question.id} className="space-y-1.5 py-3">
							<div className="flex flex-wrap items-start justify-between gap-2">
								<p className="font-medium">
									{a.question.label}
									{a.question.required && <span className="text-muted-foreground"> (required)</span>}
								</p>
								<span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
									{CLASS_LABELS[a.class]}
								</span>
							</div>
							{a.text !== null || a.choices.length > 0 ? (
								<p className="whitespace-pre-wrap">{a.text ?? a.choices.join(", ")}</p>
							) : a.escalation ? (
								<p role="status" className="rounded-md bg-warning px-3 py-2 text-warning-foreground">
									{a.escalation === "ASSESSMENT_REQUIRED"
										? "This is an assessment: it needs you."
										: "Only you can answer this."}
								</p>
							) : (
								<p className="text-muted-foreground">Left blank</p>
							)}
							{a.via && (
								<p className="text-xs text-muted-foreground">
									{VIA_COPY[a.via]}
									{a.sourceLabels.length > 0 && ` · ${a.sourceLabels.join(" · ")}`}
								</p>
							)}
						</li>
					))}
				</ol>
			</CardContent>
		</Card>
	);
}
