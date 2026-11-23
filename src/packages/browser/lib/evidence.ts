import type { Locator, Page } from "playwright";
import type { RunEventSink } from "./types";

/**
 * A screenshot kept as evidence (§10) and recorded as an event with its ref: of `target`, such
 * as the application form, else the whole page. Best effort.
 */
export async function capture(page: Page, events: RunEventSink, label: string, target?: Locator): Promise<void> {
	const png = await (target
		? target.screenshot({ timeout: 15_000 })
		: page.screenshot({ fullPage: true, timeout: 15_000 })
	).catch(() => null);
	if (!png) return;
	const ref = await events.evidence(label, png);
	await events.record({ type: "screenshot", label, ref });
}
