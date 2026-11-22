import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ApplicationStatus } from "../../packages/applications/index";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";

const POLL_MS = 30_000;
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
	PREPARING: "Preparing",
	READY: "Ready",
	APPLYING: "Applying",
	IN_REVIEW: "In Review",
	SUBMITTING: "Submitting",
	SUBMITTED: "Submitted",
	SUBMIT_UNKNOWN: "Uncertain",
	NEEDS_YOU: "Needs You",
	ABANDONED: "Abandoned",
	EXPIRED: "Expired",
};

/** Every Application, newest first (§16): what it is for, its Driving Hunt, Fit and where it is in the lifecycle. */
export function ApplicationsScreen() {
	const list = useQuery({ ...trpc.applications.list.queryOptions(), refetchInterval: POLL_MS });

	if (list.isError) return <p className="text-sm text-destructive">Applications could not be loaded.</p>;
	if (!list.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
	const applications = list.data;

	return (
		<div className="max-w-6xl space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
				<p className="text-sm text-muted-foreground">
					One per Opportunity a Hunt wants to apply to, prepared in order of high Fit and recent postings first.
				</p>
			</div>
			{applications.length === 0 ? (
				<p className="text-sm text-muted-foreground">No Applications yet.</p>
			) : (
				<div className="overflow-x-auto rounded-xl border bg-card">
					<table className="w-full text-sm">
						<thead className="border-b text-left text-xs text-muted-foreground">
							<tr>
								<th className="px-4 py-2.5 font-medium">Title</th>
								<th className="px-4 py-2.5 font-medium">Employer</th>
								<th className="px-4 py-2.5 font-medium">Driving Hunt</th>
								<th className="px-4 py-2.5 text-right font-medium">Fit</th>
								<th className="px-4 py-2.5 font-medium">Posted</th>
								<th className="px-4 py-2.5 font-medium">Status</th>
							</tr>
						</thead>
						<tbody>
							{applications.map((a) => (
								<tr key={a.id} className="border-b last:border-0">
									<td className="px-4 py-2.5">
										<Link
											to="/applications/$applicationId"
											params={{ applicationId: a.id }}
											className="font-medium hover:underline"
										>
											{a.title}
										</Link>
									</td>
									<td className="px-4 py-2.5">{a.employerName}</td>
									<td className="px-4 py-2.5">
										<Link to="/hunts/$huntId" params={{ huntId: a.drivingHunt.id }} className="hover:underline">
											{a.drivingHunt.name}
										</Link>
									</td>
									<td className="px-4 py-2.5 text-right tabular-nums">{a.fit}</td>
									<td className="whitespace-nowrap px-4 py-2.5">
										{a.postedAt ? (
											day.format(new Date(a.postedAt))
										) : (
											<span className="text-muted-foreground">Unknown</span>
										)}
									</td>
									<td className="px-4 py-2.5">
										<span
											className={cn(
												"rounded px-1.5 py-0.5 text-xs font-semibold tracking-wide",
												a.status === "SUBMITTED"
													? "bg-success/15 text-success"
													: a.status === "EXPIRED" || a.status === "ABANDONED"
														? "bg-muted text-muted-foreground"
														: "bg-primary/10 text-primary",
											)}
										>
											{a.status === "PREPARING" && !a.preparing ? "Queued" : STATUS_LABELS[a.status]}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
