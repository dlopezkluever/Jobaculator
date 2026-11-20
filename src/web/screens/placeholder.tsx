export function PlaceholderScreen({ title, description }: { title: string; description: string }) {
	return (
		<div className="space-y-2">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			<p className="max-w-prose text-sm text-muted-foreground">{description}</p>
		</div>
	);
}
