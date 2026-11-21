import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { trpc } from "../lib/trpc";
import { StatusPill } from "./hunt";

/** The overview (#30): confirmed Submitted first, then what is in flight, then what needs attention. */
export function DashboardScreen() {
	const { data } = useQuery(trpc.dashboard.summary.queryOptions());
	const hunts = useQuery(trpc.hunts.list.queryOptions());
	const count = (value: number | undefined) => (value === undefined ? "–" : value.toLocaleString());

	return (
		<div className="max-w-5xl space-y-8">
			<h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

			<section aria-labelledby="submitted" className="space-y-3">
				<h2 id="submitted" className="text-sm font-medium text-muted-foreground">
					Confirmed Submitted
				</h2>
				<div className="grid grid-cols-3 gap-4">
					<Stat label="Today" value={count(data?.submitted.today)} large />
					<Stat label="This week" value={count(data?.submitted.week)} large />
					<Stat label="All time" value={count(data?.submitted.allTime)} large />
				</div>
			</section>

			<section aria-labelledby="in-flight" className="space-y-3">
				<h2 id="in-flight" className="text-sm font-medium text-muted-foreground">
					In flight
				</h2>
				<div className="grid grid-cols-4 gap-4">
					<Stat label="Queued" value={count(data?.inFlight.queued)} />
					<Stat label="Preparing" value={count(data?.inFlight.preparing)} />
					<Stat label="In browser" value={count(data?.inFlight.inBrowser)} />
					<Stat label="Dry Runs" value={count(data?.dryRuns)} hint="Never counted as Submitted" />
				</div>
			</section>

			<section aria-labelledby="attention" className="space-y-3">
				<h2 id="attention" className="text-sm font-medium text-muted-foreground">
					Needs your attention
				</h2>
				<div className="grid grid-cols-4 gap-4">
					<AttentionTile label="Uncertain Submissions" value={count(data?.attention.uncertain)} />
					<AttentionTile label="Needs You" value={count(data?.attention.needsYou)} />
					<AttentionTile label="Ready for Review" value={count(data?.attention.review)} />
					<Stat label="Active Holds" value={count(data?.holds)} />
				</div>
			</section>

			<div className="grid grid-cols-2 gap-4">
				<Card>
					<CardHeader>
						<CardTitle>Hunt health</CardTitle>
						{hunts.data?.length === 0 && <CardDescription>No Hunts yet.</CardDescription>}
					</CardHeader>
					<CardContent className="space-y-3">
						{hunts.data && hunts.data.length > 0 && (
							<ul className="space-y-1.5 text-sm">
								{hunts.data.map((hunt) => (
									<li key={hunt.id} className="flex items-center justify-between gap-2">
										<Link to="/hunts/$huntId" params={{ huntId: hunt.id }} className="font-medium hover:underline">
											{hunt.name}
										</Link>
										<StatusPill status={hunt.status} />
									</li>
								))}
							</ul>
						)}
						<Button asChild variant="outline" size="sm">
							<Link to="/hunts/new">New Hunt</Link>
						</Button>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Recent submissions</CardTitle>
						<CardDescription>Nothing submitted yet.</CardDescription>
					</CardHeader>
				</Card>
			</div>
		</div>
	);
}

function Stat({ label, value, hint, large }: { label: string; value: string; hint?: string; large?: boolean }) {
	return (
		<Card className="gap-1.5">
			<CardContent className="space-y-1">
				<div className="text-sm text-muted-foreground">{label}</div>
				<div className={large ? "text-4xl font-semibold tabular-nums" : "text-2xl font-semibold tabular-nums"}>
					{value}
				</div>
				{hint && <div className="text-xs text-muted-foreground">{hint}</div>}
			</CardContent>
		</Card>
	);
}

function AttentionTile({ label, value }: { label: string; value: string }) {
	return (
		<Link to="/inbox" className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
			<Stat label={label} value={value} />
		</Link>
	);
}
