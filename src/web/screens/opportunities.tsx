import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "../components/ui/input";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";

const POLL_MS = 60_000;
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const time = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Every Opportunity discovered on the watched Boards, newest first, with each Board's health (§6). */
export function OpportunitiesScreen() {
	const list = useQuery({ ...trpc.opportunities.list.queryOptions(), refetchInterval: POLL_MS });
	const [filter, setFilter] = useState("");

	if (list.isError) return <p className="text-sm text-destructive">Opportunities could not be loaded.</p>;
	if (!list.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
	const { opportunities, boards } = list.data;
	const needle = filter.trim().toLowerCase();
	const shown = needle
		? opportunities.filter((o) =>
				[o.title, o.employerName, o.locationText ?? ""].some((text) => text.toLowerCase().includes(needle)),
			)
		: opportunities;
	const open = opportunities.filter((o) => o.status === "OPEN").length;

	return (
		<div className="max-w-6xl space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Opportunities</h1>
				<p className="text-sm text-muted-foreground">
					Every posting on the Boards watched for you, checked about every 2 hours while a Hunt is active.
				</p>
			</div>

			<section aria-label="Watched Boards" className="flex flex-wrap gap-2">
				{boards.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No Boards watched yet. They start with your first active Hunt.
					</p>
				)}
				{boards.map((board) => {
					const failing = board.goneAt !== null || board.lastFailure !== null;
					return (
						<div
							key={board.id}
							className={cn(
								"flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs",
								failing && "border-warning-foreground/30 bg-warning text-warning-foreground",
							)}
						>
							<span className="font-medium">{board.employerName}</span>
							<span className={failing ? undefined : "text-muted-foreground"}>
								{board.goneAt
									? "Board gone"
									: board.lastFailure
										? `Failing: ${board.lastFailure.toLowerCase().replace("_", " ")}`
										: board.lastListedAt
											? `Listed ${time.format(new Date(board.lastListedAt))}`
											: "Not listed yet"}
							</span>
						</div>
					);
				})}
			</section>

			{opportunities.length === 0 ? (
				<p className="text-sm text-muted-foreground">No Opportunities yet.</p>
			) : (
				<div className="space-y-3">
					<div className="flex items-center justify-between gap-4">
						<p className="text-sm text-muted-foreground">
							{opportunities.length} Opportunities, {open} open
						</p>
						<Input
							className="max-w-xs"
							placeholder="Filter by title, employer or location"
							aria-label="Filter Opportunities"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
						/>
					</div>
					<div className="overflow-x-auto rounded-xl border bg-card">
						<table className="w-full text-sm">
							<thead className="border-b text-left text-xs text-muted-foreground">
								<tr>
									<th className="px-4 py-2.5 font-medium">Title</th>
									<th className="px-4 py-2.5 font-medium">Employer</th>
									<th className="px-4 py-2.5 font-medium">Location</th>
									<th className="px-4 py-2.5 font-medium">Posted</th>
									<th className="px-4 py-2.5 font-medium">Status</th>
								</tr>
							</thead>
							<tbody>
								{shown.map((o) => (
									<tr key={o.id} className="border-b last:border-0">
										<td className="px-4 py-2.5">
											<a href={o.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
												{o.title}
											</a>
											{o.sightings > 1 && (
												<span className="ml-2 text-xs text-muted-foreground">{o.sightings} posts</span>
											)}
										</td>
										<td className="px-4 py-2.5">{o.employerName}</td>
										<td className="max-w-64 truncate px-4 py-2.5" title={o.locationText ?? undefined}>
											{o.locationText ?? <span className="text-muted-foreground">Not stated</span>}
										</td>
										<td className="whitespace-nowrap px-4 py-2.5">
											{o.postedAt ? (
												day.format(new Date(o.postedAt))
											) : (
												<span className="text-muted-foreground">Unknown</span>
											)}
										</td>
										<td className="px-4 py-2.5">
											<span
												className={cn(
													"rounded px-1.5 py-0.5 text-xs font-semibold tracking-wide",
													o.status === "OPEN" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
												)}
											>
												{o.status}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{shown.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">Nothing matches.</p>}
					</div>
				</div>
			)}
		</div>
	);
}
