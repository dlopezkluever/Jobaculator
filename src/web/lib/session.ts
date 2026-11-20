import { queryOptions } from "@tanstack/react-query";
import { CSRF_HEADER } from "../../api/csrf";

export type SessionUser = { email: string; name: string };

/**
 * The signed-in User, or null. Going through Better Auth's `get-session` (not tRPC) is
 * what slides the 30-day session: it renews the session and re-sets the cookie.
 */
export const sessionQuery = queryOptions({
	queryKey: ["session"],
	queryFn: async (): Promise<SessionUser | null> => {
		const response = await fetch("/api/auth/get-session");
		if (!response.ok) throw new Error(`get-session failed: ${response.status}`);
		const body = (await response.json()) as { user: SessionUser } | null;
		return body ? { email: body.user.email, name: body.user.name } : null;
	},
	staleTime: 5 * 60_000,
});

function post(path: string, body: unknown) {
	return fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", [CSRF_HEADER]: "1" },
		body: JSON.stringify(body),
	});
}

export class SignInError extends Error {
	override name = "SignInError";
}

export async function signIn(email: string, password: string): Promise<void> {
	const response = await post("/api/auth/sign-in/email", { email, password });
	if (response.ok) return;
	if (response.status === 429) throw new SignInError("Too many attempts. Wait a minute, then try again.");
	if (response.status === 401) throw new SignInError("That email and password don't match.");
	throw new SignInError("Signing in failed. Try again.");
}

export async function signOut(): Promise<void> {
	await post("/api/auth/sign-out", {});
}
