import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { CSRF_HEADER } from "../../api/csrf";
import type { AppRouter } from "../../api/router";

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// A refused session is not retried; the root redirects to sign-in instead.
			retry: (failures, error) => !isUnauthorized(error) && failures < 2,
		},
	},
});

export const trpc = createTRPCOptionsProxy<AppRouter>({
	client: createTRPCClient<AppRouter>({
		links: [httpBatchLink({ url: "/api/trpc", headers: { [CSRF_HEADER]: "1" } })],
	}),
	queryClient,
});

export function isUnauthorized(error: unknown): boolean {
	return error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED";
}
