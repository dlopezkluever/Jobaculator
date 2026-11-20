import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { sessionQuery } from "./lib/session";
import { isUnauthorized, queryClient } from "./lib/trpc";
import { createAppRouter } from "./router";
import "./styles.css";

const router = createAppRouter(queryClient);

// A session that ends while the app is open (expiry, sign-out elsewhere, a password reset) returns to sign-in.
queryClient.getQueryCache().subscribe((event) => {
	if (event.type === "updated" && isUnauthorized(event.query.state.error)) {
		queryClient.setQueryData(sessionQuery.queryKey, null);
		void router.navigate({ to: "/login" });
	}
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
