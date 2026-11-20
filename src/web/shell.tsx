import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { FileText, Inbox, LayoutDashboard, LogOut, Plus, Settings, Target, UserRound } from "lucide-react";
import type * as React from "react";
import type { SubmissionMode } from "../api/router";
import { Button } from "./components/ui/button";
import { sessionQuery, signOut } from "./lib/session";
import { trpc } from "./lib/trpc";
import { cn } from "./lib/utils";

const STATUS_POLL_MS = 15_000;

/** The app shell decided in #30: left sidebar, banners above every screen, mode and worker status in the footer. */
export function AppShell() {
	const status = useQuery({ ...trpc.system.status.queryOptions(), refetchInterval: STATUS_POLL_MS });
	const summary = useQuery(trpc.dashboard.summary.queryOptions());
	const inboxTotal = summary.data
		? summary.data.attention.needsYou + summary.data.attention.review + summary.data.attention.uncertain
		: 0;

	return (
		<div className="flex min-h-svh">
			<aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
				<div className="px-5 pt-5 pb-4 text-base font-semibold tracking-tight">Jobaculator</div>
				<nav className="flex flex-1 flex-col gap-0.5 px-3 text-sm" aria-label="Main">
					<NavItem to="/" icon={<LayoutDashboard />} label="Dashboard" />
					<NavItem to="/inbox" icon={<Inbox />} label="Inbox" badge={inboxTotal} />
					<NavItem to="/hunts" icon={<Target />} label="Hunts" />
					{/* One entry per Hunt goes here, each with its health dot and submitted-today count. */}
					<NavItem to="/hunts/new" icon={<Plus />} label="New Hunt" className="pl-8 text-muted-foreground" />
					<NavItem to="/applications" icon={<FileText />} label="Applications" />
					<NavItem to="/candidate" icon={<UserRound />} label="Candidate" />
					<NavItem to="/settings" icon={<Settings />} label="Settings" />
				</nav>
				<SidebarFooter mode={status.data?.mode} workerRunning={status.data?.workerRunning} />
			</aside>
			<div className="flex min-w-0 flex-1 flex-col">
				{status.data?.mode === "DRY_RUN" && (
					<div
						role="status"
						className="border-b border-warning-foreground/15 bg-warning px-8 py-2 text-sm text-warning-foreground"
					>
						<strong className="font-semibold">Dry Run mode.</strong> Applications are filled in completely but never
						submitted.
					</div>
				)}
				<main className="flex-1 px-8 py-7">
					<Outlet />
				</main>
			</div>
		</div>
	);
}

function NavItem({
	to,
	icon,
	label,
	badge = 0,
	className,
}: {
	to: string;
	icon: React.ReactNode;
	label: string;
	badge?: number;
	className?: string;
}) {
	return (
		<Link
			to={to}
			activeOptions={{ exact: true }}
			className={cn(
				"flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors hover:bg-sidebar-accent/60 [&_svg]:size-4 [&_svg]:shrink-0",
				"data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground",
				className,
			)}
		>
			{icon}
			<span className="flex-1">{label}</span>
			{badge > 0 && (
				<span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">{badge}</span>
			)}
		</Link>
	);
}

function SidebarFooter({ mode, workerRunning }: { mode?: SubmissionMode; workerRunning?: boolean }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const session = useQuery(sessionQuery);

	async function onSignOut() {
		await signOut();
		queryClient.clear();
		await navigate({ to: "/login" });
	}

	return (
		<div className="space-y-3 border-t border-sidebar-border px-5 py-4 text-xs">
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground">Mode</span>
				{mode === undefined ? (
					<span className="text-muted-foreground">…</span>
				) : (
					<span
						className={cn(
							"rounded px-1.5 py-0.5 font-semibold tracking-wide",
							mode === "LIVE" ? "bg-destructive text-white" : "bg-warning text-warning-foreground",
						)}
					>
						{mode === "LIVE" ? "LIVE" : "DRY RUN"}
					</span>
				)}
			</div>
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground">Worker</span>
				<span className="flex items-center gap-1.5">
					<span
						aria-hidden
						className={cn(
							"size-2 rounded-full",
							workerRunning === undefined ? "bg-muted-foreground/40" : workerRunning ? "bg-success" : "bg-destructive",
						)}
					/>
					{workerRunning === undefined ? "…" : workerRunning ? "Running" : "Stopped"}
				</span>
			</div>
			<div className="flex items-center justify-between gap-2 pt-1">
				<span className="truncate text-muted-foreground" title={session.data?.email}>
					{session.data?.email}
				</span>
				<Button
					variant="ghost"
					size="sm"
					className="size-7 p-0"
					onClick={onSignOut}
					aria-label="Sign out"
					title="Sign out"
				>
					<LogOut />
				</Button>
			</div>
		</div>
	);
}
