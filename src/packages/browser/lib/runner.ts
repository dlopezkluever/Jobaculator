import { tmpdir } from "node:os";
import { type Browser, type BrowserContext, chromium, errors, type Page } from "playwright";
import { capture } from "./evidence";
import { greenhouseDriver } from "./greenhouse";
import { blockedSubmissions, blockFormSubmission } from "./guard";
import type { Driver, PackagePort, RunEventSink, RunMode, RunOutcome } from "./types";

export type RunRequest = {
	/** The posting's apply URL, from the Job Snapshot. */
	url: string;
	mode: RunMode;
	package: PackagePort;
	events: RunEventSink;
	/** Aborts the run: the wall-clock limit, a lost heartbeat, or shutdown. */
	signal: AbortSignal;
};

export type BrowserRunner = {
	/** One Browser Run in a fresh, isolated context of the one browser (§10, §11). */
	run(request: RunRequest): Promise<RunOutcome>;
	close(): Promise<void>;
};

/** Selection order (§10): ATS adapters by fingerprint; the general agent comes later. */
const DRIVERS: readonly Driver[] = [greenhouseDriver];

/**
 * The worker's one Chromium (§17), launched on first use with a minimal environment.
 * Playwright drives it over `--remote-debugging-pipe` (it refuses that flag from callers), so
 * no debugging port exists for the egress block to have to cover. `onContext` lets tests replay
 * recorded pages in each run's context.
 */
export function createBrowserRunner(
	options: { headless?: boolean; onContext?: (context: BrowserContext) => Promise<unknown> } = {},
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
			if (request.mode !== "dry") throw new Error("only Dry Runs run until SubmitGate lands");
			const { events, signal } = request;
			let context: BrowserContext | null = null;
			let page: Page | null = null;
			let instance: Browser | null = null;
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
				const status = response?.status() ?? null;
				await events.record({ type: "opened", url: page.url(), status });
				if (status === 404 || status === 410) {
					await events.record({ type: "failed", category: "JOB_EXPIRED" });
					return { kind: "failed", category: "JOB_EXPIRED", detail: `HTTP ${status}`, url: page.url(), fields: [] };
				}
				let driver: Driver | null = null;
				for (const candidate of DRIVERS) {
					if (await candidate.matches(page.url(), page)) {
						driver = candidate;
						break;
					}
				}
				if (!driver) {
					await capture(page, events, "Unrecognized page");
					await events.record({ type: "failed", category: "UNSUPPORTED_FLOW" });
					return {
						kind: "failed",
						category: "UNSUPPORTED_FLOW",
						detail: "no ATS adapter recognizes the page",
						url: page.url(),
						fields: [],
					};
				}
				const outcome = await driver.run({ page, mode: request.mode, package: request.package, events, signal });
				const attempts = await blockedSubmissions(page.frames());
				if (attempts > 0) await events.record({ type: "submit_blocked", attempts });
				return outcome;
			} catch (error) {
				const url = page?.url() ?? null;
				if (signal.aborted) {
					const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
					return { kind: "aborted", reason, url, fields: [] };
				}
				const category =
					error instanceof errors.TimeoutError
						? "NETWORK"
						: instance && !instance.isConnected()
							? "BROWSER_FAILURE"
							: "UNKNOWN";
				await events.record({ type: "failed", category });
				const detail = error instanceof Error ? error.name : "error";
				return { kind: "failed", category, detail, url, fields: [] };
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
