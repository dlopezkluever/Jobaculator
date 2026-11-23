// Browser execution (§10, #17): Browser Runs in Playwright Chromium. Drivers (the Greenhouse
// adapter; the general agent later) fill forms with the shared `FormSession` loop, act only
// through the guarded action layer, and keep evidence through the run's event sink. Runs only
// in the worker: `web` never imports this module. Writes no tables: `pipeline` stores what
// the run reports on the Browser Run row.

export { type BrowserRunner, createBrowserRunner, type RunRequest } from "./lib/runner";
export type {
	Driver,
	PackageFile,
	PackagePort,
	RunEventSink,
	RunInput,
	RunOutcome,
} from "./lib/types";
