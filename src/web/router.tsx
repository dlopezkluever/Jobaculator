import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { sessionQuery } from "./lib/session";
import { DashboardScreen } from "./screens/dashboard";
import { LoginScreen } from "./screens/login";
import { PlaceholderScreen } from "./screens/placeholder";
import { AppShell } from "./shell";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });

const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	beforeLoad: async ({ context }) => {
		if (await context.queryClient.ensureQueryData(sessionQuery)) throw redirect({ to: "/" });
	},
	component: LoginScreen,
});

/** Every screen but sign-in sits in the sidebar shell and needs a session. */
const appRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: "app",
	beforeLoad: async ({ context }) => {
		if (!(await context.queryClient.ensureQueryData(sessionQuery))) throw redirect({ to: "/login" });
	},
	component: AppShell,
});

function placeholder(path: string, title: string, description: string) {
	return createRoute({
		getParentRoute: () => appRoute,
		path,
		component: () => <PlaceholderScreen title={title} description={description} />,
	});
}

const routeTree = rootRoute.addChildren([
	loginRoute,
	appRoute.addChildren([
		createRoute({ getParentRoute: () => appRoute, path: "/", component: DashboardScreen }),
		placeholder(
			"/inbox",
			"Inbox",
			"Nothing is waiting on you. Uncertain Submissions, Needs You and Ready for Review items appear here.",
		),
		placeholder("/hunts", "Hunts", "No Hunts yet. A Hunt searches for one kind of role and applies on your behalf."),
		placeholder("/hunts/new", "New Hunt", "Creating a Hunt is not available yet."),
		placeholder("/applications", "Applications", "No Applications yet."),
		placeholder("/candidate", "Candidate", "Your documents, facts and standing answers will live here."),
		placeholder("/settings", "Settings", "Submission mode, AI keys and spend, and alerts will live here."),
	]),
]);

export function createAppRouter(queryClient: QueryClient) {
	return createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}
