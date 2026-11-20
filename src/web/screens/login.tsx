import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { SignInError, sessionQuery, signIn } from "../lib/session";

export function LoginScreen() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setPending(true);
		setError(null);
		try {
			await signIn(String(form.get("email")), String(form.get("password")));
			// Replace the cached "signed out" so the route guard sees the new session.
			await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
			await navigate({ to: "/" });
		} catch (caught) {
			setError(caught instanceof SignInError ? caught.message : "Signing in failed. Try again.");
			setPending(false);
		}
	}

	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-xl">Sign in to Jobaculator</CardTitle>
					<CardDescription>Use the email and password your administrator set.</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="space-y-4" onSubmit={onSubmit}>
						<div className="space-y-2">
							<Label htmlFor="email">Email</Label>
							<Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
						</div>
						<div className="space-y-2">
							<Label htmlFor="password">Password</Label>
							<Input id="password" name="password" type="password" autoComplete="current-password" required />
						</div>
						{error && (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						)}
						<Button type="submit" className="w-full" disabled={pending}>
							{pending ? "Signing in…" : "Sign in"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
