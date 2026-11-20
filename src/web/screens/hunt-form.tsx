import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import {
	CREATIVE_LATITUDES,
	type CreativeLatitude,
	DEFAULT_CREATIVE_LATITUDE,
	DEFAULT_EXPERIENCE_STRETCH,
	type HuntCriteria,
	type HuntInput,
	huntInputSchema,
	type Targeting,
	TIER_LABELS,
	TIERS,
	type Tier,
} from "../../packages/hunts/criteria";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { AUTO_POLICY_COPY, LATITUDE_COPY } from "../lib/hunt-copy";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";

/** + New Hunt (§16). Conversational creation comes later; this is the structured criteria form. */
export function NewHuntScreen() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const create = useMutation(
		trpc.hunts.create.mutationOptions({
			onSuccess: async (hunt) => {
				await queryClient.invalidateQueries({ queryKey: trpc.hunts.pathKey() });
				await navigate({ to: "/hunts/$huntId", params: { huntId: hunt.id } });
			},
		}),
	);
	return (
		<HuntForm
			title="New Hunt"
			initial={emptyForm()}
			submitLabel="Start Hunt"
			pending={create.isPending}
			failed={create.isError}
			onSubmit={(input) => create.mutate(input)}
			cancel={<Link to="/hunts">Cancel</Link>}
		/>
	);
}

export function EditHuntScreen() {
	const { huntId } = useParams({ from: "/app/hunts/$huntId/edit" });
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const hunt = useQuery(trpc.hunts.get.queryOptions({ id: huntId }));
	const update = useMutation(
		trpc.hunts.update.mutationOptions({
			onSuccess: async () => {
				await queryClient.invalidateQueries({ queryKey: trpc.hunts.pathKey() });
				await navigate({ to: "/hunts/$huntId", params: { huntId } });
			},
		}),
	);
	if (hunt.isError) return <p className="text-sm text-destructive">This Hunt could not be loaded.</p>;
	if (!hunt.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
	return (
		<HuntForm
			title={`Edit ${hunt.data.name}`}
			initial={toForm(hunt.data)}
			submitLabel="Save changes"
			pending={update.isPending}
			failed={update.isError}
			onSubmit={(input) => update.mutate({ id: huntId, hunt: input })}
			cancel={
				<Link to="/hunts/$huntId" params={{ huntId }}>
					Cancel
				</Link>
			}
		/>
	);
}

type DimensionForm = { tiers: Record<Tier, string>; anythingElseUnacceptable: boolean };
type FormState = {
	name: string;
	roles: DimensionForm;
	locations: DimensionForm;
	payFloor: string;
	experienceStretch: string;
	creativeLatitude: CreativeLatitude;
};

const emptyDimension = (): DimensionForm => ({
	tiers: { ideal: "", good: "", acceptable: "", unacceptable: "" },
	anythingElseUnacceptable: false,
});

function emptyForm(): FormState {
	return {
		name: "",
		roles: { ...emptyDimension(), anythingElseUnacceptable: true },
		locations: emptyDimension(),
		payFloor: "",
		experienceStretch: "",
		creativeLatitude: DEFAULT_CREATIVE_LATITUDE,
	};
}

function toForm(hunt: { name: string; criteria: HuntCriteria; creativeLatitude: CreativeLatitude }): FormState {
	const dimension = (targeting: Targeting): DimensionForm => ({
		tiers: Object.fromEntries(TIERS.map((tier) => [tier, targeting[tier].join("\n")])) as Record<Tier, string>,
		anythingElseUnacceptable: targeting.anythingElseUnacceptable,
	});
	return {
		name: hunt.name,
		roles: dimension(hunt.criteria.roles),
		locations: dimension(hunt.criteria.locations),
		payFloor: hunt.criteria.payFloor === null ? "" : String(hunt.criteria.payFloor),
		experienceStretch: hunt.criteria.experienceStretch === null ? "" : String(hunt.criteria.experienceStretch),
		creativeLatitude: hunt.creativeLatitude,
	};
}

function toInput(form: FormState): HuntInput {
	const dimension = (d: DimensionForm): Targeting => ({
		ideal: values(d.tiers.ideal),
		good: values(d.tiers.good),
		acceptable: values(d.tiers.acceptable),
		unacceptable: values(d.tiers.unacceptable),
		anythingElseUnacceptable: d.anythingElseUnacceptable,
	});
	const pay = form.payFloor.replace(/[$,\s]/g, "");
	return {
		name: form.name,
		criteria: {
			roles: dimension(form.roles),
			locations: dimension(form.locations),
			payFloor: pay === "" ? null : Number(pay),
			experienceStretch: form.experienceStretch === "" ? null : Number(form.experienceStretch),
		},
		creativeLatitude: form.creativeLatitude,
		submissionPolicy: "AUTO",
	};
}

/** One value per line; blank lines are ignored. */
function values(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Validation messages keyed by field: "name", "criteria.roles.ideal", "criteria.payFloor", ... */
function fieldErrors(input: HuntInput): Map<string, string> {
	const result = huntInputSchema.safeParse(input);
	const errors = new Map<string, string>();
	if (result.success) return errors;
	for (const issue of result.error.issues) {
		const key = issue.path.slice(0, issue.path[0] === "criteria" ? 3 : 1).join(".");
		if (!errors.has(key)) errors.set(key, issue.message);
	}
	return errors;
}

const STRETCH_OPTIONS = [1, 1.5, 2.5, 3, 4];

function HuntForm(props: {
	title: string;
	initial: FormState;
	submitLabel: string;
	pending: boolean;
	failed: boolean;
	onSubmit(input: HuntInput): void;
	cancel: ReactNode;
}) {
	const [form, setForm] = useState(props.initial);
	const [errors, setErrors] = useState<Map<string, string>>(new Map());

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const input = toInput(form);
		const found = fieldErrors(input);
		setErrors(found);
		if (found.size === 0) props.onSubmit(input);
	}

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

	return (
		<form className="max-w-4xl space-y-6" onSubmit={onSubmit} noValidate>
			<h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>

			<div className="max-w-md space-y-2">
				<Label htmlFor="hunt-name">Name</Label>
				<Input
					id="hunt-name"
					value={form.name}
					onChange={(e) => set("name", e.target.value)}
					placeholder="AI / Software Engineering"
					aria-invalid={errors.has("name")}
				/>
				<FieldError message={errors.get("name")} />
			</div>

			<TargetingCard
				dimension="roles"
				title="Roles"
				description="Job titles, one per line. A title matches when it contains the phrase."
				placeholders={{
					ideal: "AI Engineer\nApplied AI Engineer",
					good: "Software Engineer",
					acceptable: "Developer Experience Engineer",
					unacceptable: "Intern",
				}}
				value={form.roles}
				onChange={(roles) => set("roles", roles)}
				errors={errors}
			/>
			<TargetingCard
				dimension="locations"
				title="Location"
				description="Places and arrangements, one per line. Leave every tier empty to accept any location."
				placeholders={{
					ideal: "San Francisco",
					good: "New York\nWashington DC",
					acceptable: "Remote US",
					unacceptable: "",
				}}
				value={form.locations}
				onChange={(locations) => set("locations", locations)}
				errors={errors}
			/>

			<Card>
				<CardHeader>
					<CardTitle>Pay and experience</CardTitle>
				</CardHeader>
				<CardContent className="grid gap-6 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="pay-floor">Pay floor (USD per year)</Label>
						<Input
							id="pay-floor"
							inputMode="numeric"
							value={form.payFloor}
							onChange={(e) => set("payFloor", e.target.value)}
							placeholder="No floor"
							aria-invalid={errors.has("criteria.payFloor")}
						/>
						<FieldError message={errors.get("criteria.payFloor")} />
						<p className="text-xs text-muted-foreground">
							Pay below this is unacceptable. A posting is skipped only when its whole range is below it; unknown pay
							stays eligible.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="experience-stretch">Experience stretch</Label>
						<select
							id="experience-stretch"
							value={form.experienceStretch}
							onChange={(e) => set("experienceStretch", e.target.value)}
							className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
						>
							<option value="">Default ({DEFAULT_EXPERIENCE_STRETCH}×)</option>
							{STRETCH_OPTIONS.map((x) => (
								<option key={x} value={String(x)}>
									{x}×
								</option>
							))}
						</select>
						<FieldError message={errors.get("criteria.experienceStretch")} />
						<p className="text-xs text-muted-foreground">
							Apply when a posting's required years are up to this many times yours. Only genuinely required years
							count, and adjacent experience counts too.
						</p>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Creative Latitude</CardTitle>
					<CardDescription>
						How far your resume and answers may adapt your experience. Facts stay locked.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<fieldset className="grid gap-2 sm:grid-cols-2">
						<legend className="sr-only">Creative Latitude</legend>
						{CREATIVE_LATITUDES.map((level) => (
							<Choice
								key={level}
								name="creative-latitude"
								checked={form.creativeLatitude === level}
								onChange={() => set("creativeLatitude", level)}
								label={LATITUDE_COPY[level].label}
								description={LATITUDE_COPY[level].description}
							/>
						))}
					</fieldset>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Submission policy</CardTitle>
				</CardHeader>
				<CardContent>
					<fieldset className="grid gap-2 sm:grid-cols-2">
						<legend className="sr-only">Submission policy</legend>
						<Choice
							name="submission-policy"
							checked
							onChange={() => {}}
							label={AUTO_POLICY_COPY.label}
							description={`${AUTO_POLICY_COPY.description} Review before submit is an opt-in rule that is not available yet.`}
						/>
					</fieldset>
				</CardContent>
			</Card>

			{props.failed && (
				<p role="alert" className="text-sm text-destructive">
					Saving the Hunt failed. Check the form and try again.
				</p>
			)}
			{errors.size > 0 && (
				<p role="alert" className="text-sm text-destructive">
					Fix the highlighted fields to continue.
				</p>
			)}
			<div className="flex items-center gap-3">
				<Button type="submit" disabled={props.pending}>
					{props.pending ? "Saving…" : props.submitLabel}
				</Button>
				<Button asChild variant="ghost">
					{props.cancel}
				</Button>
			</div>
		</form>
	);
}

function TargetingCard(props: {
	dimension: "roles" | "locations";
	title: string;
	description: string;
	placeholders: Record<Tier, string>;
	value: DimensionForm;
	onChange(value: DimensionForm): void;
	errors: Map<string, string>;
}) {
	const { dimension, value, onChange, errors } = props;
	const elseError = errors.get(`criteria.${dimension}.anythingElseUnacceptable`);
	return (
		<Card>
			<CardHeader>
				<CardTitle>{props.title}</CardTitle>
				<CardDescription>{props.description}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{TIERS.map((tier) => {
						const id = `${dimension}-${tier}`;
						const error = errors.get(`criteria.${dimension}.${tier}`);
						return (
							<div key={tier} className="space-y-2">
								<Label htmlFor={id}>{TIER_LABELS[tier]}</Label>
								<Textarea
									id={id}
									aria-label={`${props.title}: ${TIER_LABELS[tier]}`}
									rows={4}
									value={value.tiers[tier]}
									placeholder={props.placeholders[tier]}
									onChange={(e) => onChange({ ...value, tiers: { ...value.tiers, [tier]: e.target.value } })}
									aria-invalid={error !== undefined}
								/>
								<FieldError message={error} />
							</div>
						);
					})}
				</div>
				<div className="space-y-1">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							className="size-4 accent-primary"
							checked={value.anythingElseUnacceptable}
							onChange={(e) => onChange({ ...value, anythingElseUnacceptable: e.target.checked })}
						/>
						Anything else is unacceptable
					</label>
					<p className="pl-6 text-xs text-muted-foreground">
						{value.anythingElseUnacceptable
							? "Only the values listed above qualify."
							: "Values not listed count as Acceptable."}
					</p>
					<FieldError message={elseError} />
				</div>
			</CardContent>
		</Card>
	);
}

function Choice(props: { name: string; checked: boolean; onChange(): void; label: string; description: string }) {
	return (
		<label
			className={cn(
				"flex cursor-pointer gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-accent/50",
				props.checked && "border-primary/60 bg-accent/60",
			)}
		>
			<input
				type="radio"
				name={props.name}
				checked={props.checked}
				onChange={props.onChange}
				className="mt-0.5 size-4 shrink-0 accent-primary"
			/>
			<span className="space-y-1">
				<span className="block font-medium">{props.label}</span>
				<span className="block text-muted-foreground">{props.description}</span>
			</span>
		</label>
	);
}

function FieldError({ message }: { message: string | undefined }) {
	if (!message) return null;
	return <p className="text-xs text-destructive">{message}</p>;
}
