import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { AlertTriangle, CheckCircle2, FileText, Loader2, RotateCcw, Upload } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { CSRF_HEADER } from "../../api/csrf";
import type { AppRouter } from "../../api/router";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";

type Document = inferRouterOutputs<AppRouter>["candidate"]["documents"]["list"][number];

// The server enforces both; checking here saves a pointless upload.
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_BATCH = 20;
const ACCEPT = ".pdf,.docx,.txt,.md,.markdown";
const FORMAT_LABEL: Record<Document["format"], string> = {
	pdf: "PDF",
	docx: "DOCX",
	text: "Text",
	markdown: "Markdown",
};

const pending = (documents: readonly Document[] | undefined) =>
	documents?.some((d) => d.status === "queued" || d.status === "extracting") ?? false;

/** The Candidate's documents, polled while any is still being read. */
export function useDocuments() {
	return useQuery({
		...trpc.candidate.documents.list.queryOptions(),
		refetchInterval: (query) => (pending(query.state.data) ? 2000 : false),
	});
}

type Notice = { tone: "info" | "error"; text: string };

/** Upload or paste documents (#21), and see each one's extraction. */
export function DocumentsCard() {
	const queryClient = useQueryClient();
	const documents = useDocuments();
	const invalidate = () => queryClient.invalidateQueries({ queryKey: trpc.candidate.documents.list.queryKey() });
	const [notices, setNotices] = useState<Notice[]>([]);
	const [uploading, setUploading] = useState<string | null>(null);
	const [pasting, setPasting] = useState(false);
	const [dragging, setDragging] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	// When a document finishes, its Facts are in the Knowledge Base: show them.
	const extracted = documents.data?.filter((d) => d.status === "extracted").length ?? 0;
	useEffect(() => {
		if (extracted > 0) void queryClient.invalidateQueries({ queryKey: trpc.candidate.knowledgeBase.queryKey() });
	}, [extracted, queryClient]);

	const paste = useMutation(
		trpc.candidate.documents.paste.mutationOptions({
			onSuccess: (result) => {
				setPasting(false);
				setNotices(result.duplicate ? [{ tone: "info", text: "That text was already added, so it was skipped." }] : []);
				void invalidate();
			},
		}),
	);
	const retry = useMutation(trpc.candidate.documents.retry.mutationOptions({ onSuccess: () => void invalidate() }));

	async function uploadAll(files: File[]) {
		if (files.length === 0) return;
		if (files.length > MAX_BATCH) {
			return setNotices([{ tone: "error", text: `Choose at most ${MAX_BATCH} files at a time.` }]);
		}
		const next: Notice[] = [];
		// One file per request, so each succeeds or fails on its own.
		for (const file of files) {
			if (file.size > MAX_BYTES) {
				next.push({ tone: "error", text: `${file.name}: the file is larger than 10 MB.` });
				continue;
			}
			setUploading(file.name);
			try {
				const body = new FormData();
				body.set("file", file);
				const response = await fetch("/api/candidate/documents", {
					method: "POST",
					body,
					headers: { [CSRF_HEADER]: "1" },
				});
				const result = (await response.json().catch(() => ({}))) as {
					error?: string;
					duplicate?: boolean;
					document?: Document;
				};
				if (!response.ok) next.push({ tone: "error", text: `${file.name}: ${result.error ?? "the upload failed."}` });
				else if (result.duplicate) {
					next.push({
						tone: "info",
						text: `${file.name} was already uploaded as ${result.document?.filename}, so it was skipped.`,
					});
				}
			} catch {
				next.push({ tone: "error", text: `${file.name}: the upload failed. Check your connection and try again.` });
			}
			await invalidate();
		}
		setUploading(null);
		setNotices(next);
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		setDragging(false);
		void uploadAll([...event.dataTransfer.files]);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Documents</CardTitle>
				<CardDescription>
					Upload your resume, a LinkedIn export or notes about your work, and the details in them are added to your
					profile. PDF, DOCX, TXT or Markdown, up to 10 MB each and 20 at a time.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* biome-ignore lint/a11y/noStaticElementInteractions: the drop zone is a shortcut; the buttons inside do the same. */}
				<div
					onDragOver={(event) => {
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={onDrop}
					className={cn(
						"flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground",
						dragging && "border-primary bg-accent",
					)}
				>
					<Upload className="size-4" />
					{uploading ? (
						<span className="flex items-center gap-2" role="status">
							<Loader2 className="size-4 animate-spin" /> Uploading {uploading}…
						</span>
					) : (
						<>
							<span>Drop files here, or</span>
							<Button variant="outline" size="sm" onClick={() => input.current?.click()}>
								Choose files
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setPasting(true)} disabled={pasting}>
								Paste text
							</Button>
						</>
					)}
					<input
						ref={input}
						type="file"
						multiple
						accept={ACCEPT}
						className="hidden"
						aria-label="Choose documents"
						onChange={(event) => {
							void uploadAll([...(event.target.files ?? [])]);
							event.target.value = "";
						}}
					/>
				</div>

				{pasting && (
					<form
						className="space-y-2"
						onSubmit={(event) => {
							event.preventDefault();
							const text = String(new FormData(event.currentTarget).get("text") ?? "");
							if (text.trim()) paste.mutate({ text });
						}}
					>
						<Textarea
							name="text"
							rows={6}
							autoFocus
							aria-label="Pasted text"
							placeholder="Paste a resume, a profile or anything about your work."
						/>
						<div className="flex items-center gap-2">
							<Button type="submit" size="sm" disabled={paste.isPending}>
								{paste.isPending ? "Adding…" : "Add text"}
							</Button>
							<Button type="button" size="sm" variant="ghost" onClick={() => setPasting(false)}>
								Cancel
							</Button>
							{paste.error && (
								<p role="alert" className="text-sm text-destructive">
									{paste.error.message}
								</p>
							)}
						</div>
					</form>
				)}

				{notices.length > 0 && (
					<ul className="space-y-1 text-sm" role="status">
						{notices.map((notice) => (
							<li key={notice.text} className={notice.tone === "error" ? "text-destructive" : "text-muted-foreground"}>
								{notice.text}
							</li>
						))}
					</ul>
				)}

				{documents.data && documents.data.length > 0 && (
					<ul className="divide-y rounded-md border">
						{documents.data.map((document) => (
							<DocumentRow
								key={document.id}
								document={document}
								onRetry={() => retry.mutate({ documentId: document.id })}
								retrying={retry.isPending && retry.variables?.documentId === document.id}
							/>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentRow({ document, onRetry, retrying }: { document: Document; onRetry: () => void; retrying: boolean }) {
	const added = new Date(document.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return (
		<li className="flex items-start gap-3 px-3 py-2.5 text-sm">
			<FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1 space-y-1">
				<div className="truncate font-medium">{document.filename}</div>
				<div className="text-xs text-muted-foreground">
					{FORMAT_LABEL[document.format]} · {size(document.size)} · Added {added}
				</div>
				{document.status === "failed" && <p className="text-destructive">{document.error}</p>}
				{document.note && (
					<p className="flex items-start gap-1 text-xs text-warning-foreground">
						<AlertTriangle className="mt-0.5 size-3 shrink-0" /> {document.note}
					</p>
				)}
			</div>
			<div className="shrink-0 pt-0.5 text-muted-foreground">
				{document.status === "queued" && (
					<span className="flex items-center gap-1.5">
						<Loader2 className="size-3.5 animate-spin" /> Waiting
					</span>
				)}
				{document.status === "extracting" && (
					<span className="flex items-center gap-1.5">
						<Loader2 className="size-3.5 animate-spin" /> Reading…
					</span>
				)}
				{document.status === "extracted" && (
					<span className="flex items-center gap-1.5">
						<CheckCircle2 className="size-3.5 text-success" />
						{document.factCount === 1 ? "1 detail" : `${document.factCount ?? 0} details`}
					</span>
				)}
				{document.status === "failed" && (
					<Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
						<RotateCcw /> Retry
					</Button>
				)}
			</div>
		</li>
	);
}
