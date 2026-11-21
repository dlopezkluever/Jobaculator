import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Pause, Pencil, Play, Plus } from "lucide-react";
import { DEFAULT_EXPERIENCE_STRETCH, type Targeting, TIER_LABELS, TIERS } from "../../packages/hunts/criteria";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { AUTO_POLICY_COPY, formatPay, LATITUDE_COPY } from "../lib/hunt-copy";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";

/** The Hunts list: every Hunt with its status, and + New Hunt. */
export function HuntsScreen() {
	const hunts = useQuery(trpc.hunts.list.queryOptions());
	return (
		<div className="max-w-5xl space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-semibold tracking-tight">Hunts</h1>
				<Button asChild>
					<Link to="/hunts/new">
						<Plus />
						New Hunt
					</Link>
				</Button>
			</div>
			{hunts.data?.length === 0 && (
				<p className="max-w-prose text-sm text-muted-foreground">
					No Hunts yet. A Hunt searches for one kind of role and applies on your behalf.
				</p>
			)}
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{hunts.data?.map((hunt) => (
					<Link
						key={hunt.id}
						to="/hunts/$huntId"
						params={{ huntId: hunt.id }}
						className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
					>
						<Card className="h-full transition-colors hover:bg-accent/40">
							<CardHeader>
								<div className="flex items-start justify-between gap-2">
									<CardTitle className="leading-snug">{hunt.name}</CardTitle>
									<StatusPill status={hunt.status} />
								</div>
								<CardDescription>{summarize(hunt.criteria.roles) || "Any role"}</CardDescription>
							</CardHeader>
						</Card>
					</Link>
				))}
			</div>
		</div>
	);
}

/** The Hunt page (§16): controls and targeting now; the pipeline lane and health arrive with later tickets. */
export function HuntScreen() {
	const { huntId } = useParams({ from: "/app/hunts/$huntId" });
	const queryClient = useQueryClient();
	const hunt = useQuery(trpc.hunts.get.queryOptions({ id: huntId }));
	const setStatus = useMutation(
		trpc.hunts.setStatus.mutationOptions({
			onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.hunts.pathKey() }),
		}),
	);

	if (hunt.isError) return <p className="text-sm text-destructive">This Hunt could not be loaded.</p>;
	if (!hunt.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
	const { name, status, criteria, creativeLatitude, activity } = hunt.data;
	const paused = status === "PAUSED";

	return (
		<div className="max-w-5xl space-y-6">
			<div className="space-y-1">
				<Link to="/hunts" className="text-xs text-muted-foreground hover:underline">
					Hunts /
				</Link>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-3">
						<h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
						<StatusPill status={status} />
					</div>
					<div className="flex items-center gap-2">
						<Button asChild variant="outline">
							<Link to="/hunts/$huntId/edit" params={{ huntId }}>
								<Pencil />
								Edit
							</Link>
						</Button>
						<Button
							variant={paused ? "default" : "outline"}
							disabled={setStatus.isPending}
							onClick={() => setStatus.mutate({ id: huntId, status: paused ? "ACTIVE" : "PAUSED" })}
						>
							{paused ? <Play /> : <Pause />}
							{paused ? "Resume" : "Pause"}
						</Button>
					</div>
				</div>
				<p className="text-sm text-muted-foreground">
					{paused
						? "Paused: this Hunt judges no new postings and starts no new Applications. Applications already in flight continue."
						: "Active: this Hunt judges every new posting on your watched Boards."}
				</p>
				{setStatus.isError && (
					<p role="alert" className="text-sm text-destructive">
						Changing the Hunt's status failed. Try again.
					</p>
				)}
			</div>

			<div className="grid gap-4 lg:grid-cols-3">
				<Card className="lg:col-span-2">
					<CardHeader>
						<CardTitle>Targeting</CardTitle>
					</CardHeader>
					<CardContent className="space-y-5 text-sm">
						<TargetingSummary label="Roles" targeting={criteria.roles} />
						<TargetingSummary label="Location" targeting={criteria.locations} />
						<dl className="grid grid-cols-2 gap-4">
							<div>
								<dt className="font-medium">Pay floor</dt>
								<dd className="text-muted-foreground">
									{criteria.payFloor === null ? "None" : formatPay(criteria.payFloor)}
								</dd>
							</div>
							<div>
								<dt className="font-medium">Experience stretch</dt>
								<dd className="text-muted-foreground">
									{criteria.experienceStretch === null
										? `Default (${DEFAULT_EXPERIENCE_STRETCH}×)`
										: `${criteria.experienceStretch}×`}
								</dd>
							</div>
						</dl>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Controls</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4 text-sm">
						<div className="space-y-1">
							<div className="font-medium">Creative Latitude: {LATITUDE_COPY[creativeLatitude].label}</div>
							<p className="text-muted-foreground">{LATITUDE_COPY[creativeLatitude].description}</p>
						</div>
						<div className="space-y-1">
							<div className="font-medium">Submission policy: {AUTO_POLICY_COPY.label}</div>
							<p className="text-muted-foreground">{AUTO_POLICY_COPY.description}</p>
						</div>
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Activity</CardTitle>
				</CardHeader>
				<CardContent>
					<ol className="space-y-2 text-sm">
						{activity.map((event) => (
							<li key={event.id} className="flex gap-4">
								<time
									className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground"
									dateTime={event.occurredAt}
								>
									{new Date(event.occurredAt).toLocaleString()}
								</time>
								<span>{describeEvent(event.code, event.payload)}</span>
							</li>
						))}
					</ol>
				</CardContent>
			</Card>
		</div>
	);
}

export function StatusPill({ status }: { status: "ACTIVE" | "PAUSED" }) {
	return (
		<span
			className={cn(
				"rounded px-1.5 py-0.5 text-xs font-semibold tracking-wide",
				status === "ACTIVE" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
			)}
		>
			{status}
		</span>
	);
}

function TargetingSummary({ label, targeting }: { label: string; targeting: Targeting }) {
	const listed = TIERS.filter((tier) => targeting[tier].length > 0);
	return (
		<div className="space-y-1.5">
			<div className="font-medium">{label}</div>
			{listed.length === 0 && !targeting.anythingElseUnacceptable ? (
				<p className="text-muted-foreground">Unconstrained</p>
			) : (
				<dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
					{listed.map((tier) => (
						<div key={tier} className="contents">
							<dt className="text-muted-foreground">{TIER_LABELS[tier]}</dt>
							<dd>{targeting[tier].join(", ")}</dd>
						</div>
					))}
					<dt className="text-muted-foreground">Anything else</dt>
					<dd>{targeting.anythingElseUnacceptable ? "Unacceptable" : "Acceptable"}</dd>
				</dl>
			)}
		</div>
	);
}

function summarize(targeting: Targeting): string {
	return [...targeting.ideal, ...targeting.good, ...targeting.acceptable].join(", ");
}

const FIELD_NAMES: Record<string, string> = {
	name: "name",
	criteria: "targeting",
	creativeLatitude: "Creative Latitude",
	submissionPolicy: "submission policy",
};

function describeEvent(code: string, payload: unknown): string {
	switch (code) {
		case "hunt_created":
			return "Hunt created";
		case "hunt_paused":
			return "Paused";
		case "hunt_resumed":
			return "Resumed";
		case "hunt_edited": {
			const changed = (payload as { changed?: string[] }).changed ?? [];
			return `Changed ${changed.map((field) => FIELD_NAMES[field] ?? field).join(", ")}`;
		}
		default:
			return code;
	}
}
