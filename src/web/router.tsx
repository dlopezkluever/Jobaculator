import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { sessionQuery } from "./lib/session";
import { DashboardScreen } from "./screens/dashboard";
import { HuntScreen, HuntsScreen } from "./screens/hunt";
import { EditHuntScreen, NewHuntScreen } from "./screens/hunt-form";
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
		createRoute({ getParentRoute: () => appRoute, path: "/hunts", component: HuntsScreen }),
		createRoute({ getParentRoute: () => appRoute, path: "/hunts/new", component: NewHuntScreen }),
		createRoute({ getParentRoute: () => appRoute, path: "/hunts/$huntId", component: HuntScreen }),
		createRoute({ getParentRoute: () => appRoute, path: "/hunts/$huntId/edit", component: EditHuntScreen }),
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
