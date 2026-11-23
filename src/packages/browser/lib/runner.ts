import { tmpdir } from "node:os";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { classifyFailure } from "./classify";
import { capture } from "./evidence";
import { greenhouseDriver } from "./greenhouse";
import { blockedSubmissions, blockFormSubmission } from "./guard";
import type {
	Driver,
	FailureCategory,
	FieldRecord,
	PackagePort,
	RunAi,
	RunEventSink,
	RunMode,
	RunOutcome,
	SubmitGate,
} from "./types";

export type RunRequest = {
	/** The posting's apply URL, from the Job Snapshot. */
	url: string;
	mode: RunMode;
	package: PackagePort;
	events: RunEventSink;
	/** The submit boundary; a live run crosses it before its one final click. */
	gate: SubmitGate;
	/** Aborts the run: the wall-clock limit, a lost heartbeat, or shutdown. */
	signal: AbortSignal;
	ai: RunAi;
};

export type BrowserRunner = {
	/** One Browser Run in a fresh, isolated context of the one browser (§10, §11). */
	run(request: RunRequest): Promise<RunOutcome>;
	close(): Promise<void>;
};

const reasonOf = (signal: AbortSignal) =>
	signal.reason instanceof Error ? signal.reason.message : String(signal.reason);

/** Selection order (§10): ATS adapters by fingerprint; the general agent comes later. */
const DRIVERS: readonly Driver[] = [greenhouseDriver];

/**
 * The worker's one Chromium (§17), launched on first use with a minimal environment.
 * Playwright drives it over `--remote-debugging-pipe` (it refuses that flag from callers), so
 * no debugging port exists for the egress block to have to cover. `onContext` lets tests replay
 * recorded pages in each run's context.
 */
/** How long a page has to show its confirmation after the final click (§10); tune on live runs (§21). */
const CONFIRMATION_TIMEOUT_MS = 45_000;

export function createBrowserRunner(
	options: {
		headless?: boolean;
		onContext?: (context: BrowserContext) => Promise<unknown>;
		confirmationTimeoutMs?: number;
	} = {},
): BrowserRunner {
	let launched: Promise<Browser> | null = null;
	const browser = () => {
		launched ??= chromium
			.launch({
				headless: options.headless ?? true,
				env: { PATH: process.env.PATH ?? "", HOME: tmpdir() },
			})
			.then((b) => {
				// A crashed browser is launched again for the next run.
				b.on("disconnected", () => {
					launched = null;
				});
				return b;
			});
		launched.catch(() => {
			launched = null;
		});
		return launched;
	};

	return {
		async run(request) {
			if (request.mode === "refill_and_submit") throw new Error("refill_and_submit arrives with Review (TB3)");
			const { events, signal } = request;
			// Set once the run has crossed the submit boundary: from then on nothing is a failure to retry.
			let crossed = false;
			const gate: SubmitGate = {
				async cross(fields) {
					crossed = await request.gate.cross(fields);
					return crossed;
				},
			};
			let context: BrowserContext | null = null;
			let page: Page | null = null;
			let instance: Browser | null = null;
			let status: number | null = null;
			/** A failure before the boundary, classified (§10) while its page is still open. */
			const fail = async (
				reported: { category: FailureCategory; detail: string },
				error: unknown = null,
				fields: FieldRecord[] = [],
			): Promise<RunOutcome> => {
				// What an abort broke is not the run's failure: it uses no attempt.
				if (signal.aborted) return { kind: "aborted", reason: reasonOf(signal), url: page?.url() ?? null, fields };
				const { category, by } = await classifyFailure({
					page,
					status,
					reported,
					error,
					browserGone: instance !== null && !instance.isConnected(),
					ai: request.ai,
					signal,
				});
				// The page itself explains the failure: keep it as the Intervention's evidence (§5).
				if (page && (by === "page" || by === "model")) await capture(page, events, "Failed");
				await events.record({ type: "failed", category, by });
				return { kind: "failed", category, detail: reported.detail, url: page?.url() ?? null, fields };
			};
			// Closing the context ends whatever the run is waiting on.
			const abort = () => void context?.close().catch(() => {});
			signal.addEventListener("abort", abort, { once: true });
			try {
				instance = await browser();
				context = await instance.newContext({
					viewport: { width: 1280, height: 900 },
					locale: "en-US",
					serviceWorkers: "block",
					acceptDownloads: false,
				});
				signal.throwIfAborted();
				await options.onContext?.(context);
				await blockFormSubmission(context);
				page = await context.newPage();
				const response = await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
				await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
				status = response?.status() ?? null;
				await events.record({ type: "opened", url: page.url(), status });
				if (status === 404 || status === 410) return await fail({ category: "JOB_EXPIRED", detail: `HTTP ${status}` });
				let driver: Driver | null = null;
				for (const candidate of DRIVERS) {
					if (await candidate.matches(page.url(), page)) {
						driver = candidate;
						break;
					}
				}
				if (!driver) {
					await capture(page, events, "Unrecognized page");
					return await fail({ category: "UNSUPPORTED_FLOW", detail: "no ATS adapter recognizes the page" });
				}
				const outcome = await driver.run({
					page,
					mode: request.mode,
					package: request.package,
					events,
					gate,
					signal,
					confirmationTimeoutMs: options.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS,
				});
				const attempts = await blockedSubmissions(page.frames());
				if (attempts > 0) await events.record({ type: "submit_blocked", attempts });
				if (outcome.kind === "failed") return await fail(outcome, null, outcome.fields);
				return outcome;
			} catch (error) {
				const url = page?.url() ?? null;
				if (crossed) {
					const detail = error instanceof Error ? error.name : "error";
					return { kind: "submit_unknown", detail, url, fields: [] };
				}
				if (signal.aborted) return { kind: "aborted", reason: reasonOf(signal), url, fields: [] };
				return await fail({ category: "UNKNOWN", detail: error instanceof Error ? error.name : "error" }, error);
			} finally {
				signal.removeEventListener("abort", abort);
				await context?.close().catch(() => {});
			}
		},
		async close() {
			const current = launched;
			launched = null;
			await (await current?.catch(() => null))?.close();
		},
	};
}
