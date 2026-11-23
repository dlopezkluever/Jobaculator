import { access } from "node:fs/promises";
import { join } from "node:path";
import { max } from "drizzle-orm";
import type { Executor } from "../db/index";
import { launchStep } from "./lib/schema";
import { LAUNCH_STEPS, type LaunchStep } from "./lib/types";

// The launch gate and the recovery marker (§13, §17, #22): what must be true system-wide before
// anything is submitted. Live stays refused until a passed restore drill and the submit-intent
// journal's activation are recorded; a recovery marker outside Postgres blocks dispatch and
// the submit boundary whatever the restored database says. The ops commands that record the
// steps and write the marker (`drill`, `journal:activate`, `restore`) are TB1-17's.

export { LAUNCH_STEPS, type LaunchStep } from "./lib/types";

export const LIVE_REFUSED = "Live submission stays off until the launch gate (restore drill and journal) is recorded";

/** Live was asked for while the launch gate is closed. */
export class LiveRefused extends Error {
	override name = "LiveRefused";
	constructor() {
		super(LIVE_REFUSED);
	}
}

/** Records one launch-gate step. Recording a step again keeps the earlier record. */
export async function recordLaunchStep(
	exec: Executor,
	step: LaunchStep,
	detail: Record<string, string> = {},
): Promise<void> {
	await exec.insert(launchStep).values({ step, detail });
}

export type LaunchGate = { open: boolean; steps: Record<LaunchStep, Date | null> };

/** Which steps are recorded, and when first. Open once every step is. */
export async function getLaunchGate(exec: Executor): Promise<LaunchGate> {
	const rows = await exec
		.select({ step: launchStep.step, at: max(launchStep.recordedAt) })
		.from(launchStep)
		.groupBy(launchStep.step);
	const steps = Object.fromEntries(
		LAUNCH_STEPS.map((step) => [step, rows.find((row) => row.step === step)?.at ?? null]),
	) as Record<LaunchStep, Date | null>;
	return { open: LAUNCH_STEPS.every((step) => steps[step] !== null), steps };
}

/** Throws `LiveRefused` while the launch gate is closed. */
export async function assertLiveAllowed(exec: Executor): Promise<void> {
	if (!(await getLaunchGate(exec)).open) throw new LiveRefused();
}

/** The recovery marker (§13): a file outside Postgres that `restore` writes and `recovery-complete` removes. */
export type RecoveryMarker = { present(): Promise<boolean> };

/** The marker file in the data directory. Anything but its certain absence counts as present. */
export function recoveryMarker(dataDir: string): RecoveryMarker {
	const path = join(dataDir, "RECOVERY_IN_PROGRESS");
	return {
		present: () =>
			access(path).then(
				() => true,
				(error: NodeJS.ErrnoException) => error.code !== "ENOENT",
			),
	};
}
