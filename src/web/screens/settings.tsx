import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";

const PROVIDERS = [
	{ id: "anthropic", name: "Anthropic", placeholder: "sk-ant-…" },
	{ id: "openai", name: "OpenAI", placeholder: "sk-…" },
] as const;

const PRESETS = [
	{ id: "economy", name: "Economy", hint: "Cheapest models that do the job." },
	{ id: "standard", name: "Standard", hint: "Balanced cost and quality." },
	{ id: "best", name: "Best", hint: "Strongest models for writing and judgement." },
] as const;

/** Settings → AI keys and spend (§12). Keys are write-only: only their last 4 characters ever come back. */
export function SettingsScreen() {
	const settings = useQuery(trpc.ai.settings.queryOptions());
	const data = settings.data;

	return (
		<div className="max-w-3xl space-y-8">
			<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
			<Card>
				<CardHeader>
					<CardTitle>AI provider keys</CardTitle>
					<CardDescription>
						Your own keys pay for every AI call. They are encrypted at rest and never shown again after you save them.
					</CardDescription>
				</CardHeader>
				<CardContent className="divide-y">
					{PROVIDERS.map((provider) => (
						<ProviderKeyRow
							key={provider.id}
							provider={provider}
							last4={data?.keys.find((k) => k.provider === provider.id)?.last4}
						/>
					))}
				</CardContent>
			</Card>
			{data && <SpendCard preset={data.preset} dailyCapUsd={data.dailyCapUsd} spentTodayUsd={data.spentTodayUsd} />}
		</div>
	);
}

function useInvalidateSettings() {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: trpc.ai.settings.queryKey() });
}

function ProviderKeyRow({ provider, last4 }: { provider: (typeof PROVIDERS)[number]; last4: string | undefined }) {
	const invalidate = useInvalidateSettings();
	const [value, setValue] = useState("");
	const save = useMutation(
		trpc.ai.saveKey.mutationOptions({
			onSuccess: async () => {
				setValue("");
				await invalidate();
			},
		}),
	);
	const remove = useMutation(trpc.ai.removeKey.mutationOptions({ onSuccess: invalidate }));
	const inputId = `key-${provider.id}`;

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		save.mutate({ provider: provider.id, key: value });
	}

	return (
		<form className="space-y-2 py-4 first:pt-0 last:pb-0" onSubmit={onSubmit}>
			<div className="flex items-center justify-between">
				<Label htmlFor={inputId}>{provider.name}</Label>
				<span className="text-sm text-muted-foreground">
					{last4 ? (
						<>
							Saved key ending in <span className="font-mono text-foreground">…{last4}</span>
						</>
					) : (
						"No key saved"
					)}
				</span>
			</div>
			<div className="flex gap-2">
				<Input
					id={inputId}
					type="password"
					autoComplete="off"
					spellCheck={false}
					placeholder={last4 ? "Paste a new key to replace it" : provider.placeholder}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					aria-invalid={save.isError || undefined}
				/>
				<Button type="submit" disabled={!value.trim() || save.isPending}>
					{save.isPending ? "Saving…" : "Save"}
				</Button>
				{last4 && (
					<Button
						type="button"
						variant="outline"
						disabled={remove.isPending}
						onClick={() => remove.mutate({ provider: provider.id })}
					>
						Remove
					</Button>
				)}
			</div>
			{save.isError && (
				<p role="alert" className="text-sm text-destructive">
					{save.error.message}
				</p>
			)}
		</form>
	);
}

function SpendCard({
	preset,
	dailyCapUsd,
	spentTodayUsd,
}: {
	preset: string;
	dailyCapUsd: number | null;
	spentTodayUsd: number;
}) {
	const invalidate = useInvalidateSettings();
	const update = useMutation(trpc.ai.updateSettings.mutationOptions({ onSuccess: invalidate }));
	const [cap, setCap] = useState(dailyCapUsd === null ? "" : String(dailyCapUsd));

	function onSaveCap(event: FormEvent) {
		event.preventDefault();
		const trimmed = cap.trim();
		update.mutate({ dailyCapUsd: trimmed === "" ? null : Number(trimmed) });
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Models and spend</CardTitle>
				<CardDescription>
					Spent today: <span className="font-medium text-foreground tabular-nums">${spentTodayUsd.toFixed(4)}</span>
					{dailyCapUsd !== null && <> of ${dailyCapUsd.toFixed(2)}</>}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<fieldset className="space-y-2">
					<legend className="text-sm font-medium">Model preset</legend>
					<div className="grid grid-cols-3 gap-2">
						{PRESETS.map((option) => (
							<button
								key={option.id}
								type="button"
								aria-pressed={preset === option.id}
								disabled={update.isPending}
								onClick={() => update.mutate({ preset: option.id })}
								className={cn(
									"rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
									preset === option.id && "border-primary bg-accent",
								)}
							>
								<div className="font-medium">{option.name}</div>
								<div className="text-xs text-muted-foreground">{option.hint}</div>
							</button>
						))}
					</div>
				</fieldset>
				<form className="space-y-2" onSubmit={onSaveCap}>
					<Label htmlFor="daily-cap">Daily AI spend cap (USD)</Label>
					<div className="flex gap-2">
						<Input
							id="daily-cap"
							type="number"
							min="0"
							step="0.01"
							inputMode="decimal"
							placeholder="No cap"
							value={cap}
							onChange={(event) => setCap(event.target.value)}
							className="w-40"
						/>
						<Button type="submit" variant="outline" disabled={update.isPending}>
							Save cap
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						When a call would go over the cap, AI work waits until the next day. Leave empty for no cap.
					</p>
					{update.isError && (
						<p role="alert" className="text-sm text-destructive">
							{update.error.message}
						</p>
					)}
				</form>
			</CardContent>
		</Card>
	);
}
