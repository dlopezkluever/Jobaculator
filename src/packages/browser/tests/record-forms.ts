import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { RECORDED_FORMS } from "../testing";

// Records the real Greenhouse form pages the browser tests replay (§18), with
// `pnpm test:record-forms`. Only GETs to the hosts that serve the form are recorded; every
// other request (analytics, reCAPTCHA, Google and Dropbox pickers) is aborted, and nothing is
// filled in or uploaded, so recording sends nothing to the employer. The location search the
// tests type is recorded too. Overwrites the fixtures; review the diff before committing.

for (const form of Object.values(RECORDED_FORMS)) {
	const browser = await chromium.launch();
	const context = await browser.newContext({ serviceWorkers: "block" });
	await context.route("**/*", (route) => {
		const request = route.request();
		return request.method() === "GET" && form.hosts.test(request.url()) ? route.continue() : route.abort();
	});
	await context.routeFromHAR(form.har, {
		update: true,
		updateContent: "attach",
		updateMode: "minimal",
		url: form.hosts,
	});
	const page = await context.newPage();
	for (const url of [form.url, form.embedUrl]) {
		await page.goto(url, { waitUntil: "networkidle" });
		const location = page.locator("#candidate-location");
		await location.click();
		await location.pressSequentially(form.locationSearch, { delay: 80 });
		await page.locator('[id^="react-select-candidate-location-option"]').first().waitFor();
	}
	await context.close();
	await browser.close();

	const response = await fetch(form.questionsUrl);
	if (!response.ok) throw new Error(`questions=true returned ${response.status}`);
	const recorded = {
		note: "Recorded from the live Greenhouse job-board API (questions=true), unmodified.",
		recordedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
		url: form.questionsUrl,
		body: await response.json(),
	};
	writeFileSync(form.questions, `${JSON.stringify(recorded, null, "\t")}\n`);
	// The confirmation page anyone can open; recording it submits nothing.
	const confirmation = await fetch(form.confirmationUrl);
	if (!confirmation.ok) throw new Error(`the confirmation page returned ${confirmation.status}`);
	writeFileSync(form.confirmation, await confirmation.text());
	console.log(`recorded ${form.url}`);
}
