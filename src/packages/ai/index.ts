import type { Executor } from "../db/index";
import type { UserId } from "../db/ownership";
import { readSettings, type Settings, spentTodayMicroUsd, writeSettings } from "./lib/ledger";
import type { Preset, Task } from "./lib/types";

// The AI gateway (§12, #15). Every LLM call in `web` and `worker` goes through `LlmClient`;
// this module is the only writer of provider keys, AI settings, the ledger and scope health.

export { type FetchLike, LiveCallBlocked } from "./lib/adapter";
export { createLlmClient, type LlmClientOptions } from "./lib/gateway";
export {
	KeyValidationError,
	listProviderKeys,
	type ProviderKeySummary,
	removeProviderKey,
	saveProviderKey,
} from "./lib/keys";
export { PAYLOAD_RETENTION_DAYS, purgeExpiredPayloads, SettingsError } from "./lib/ledger";
export { MODELS, PRICE_TABLE_VERSION, ROUTES } from "./lib/models";
export {
	type ActionResult,
	type Attribution,
	BudgetExceeded,
	type CallReceipt,
	type ComputerAction,
	type ComputerStep,
	type ComputerTurnRequest,
	type ComputerTurnResult,
	type FailureKind,
	type FailureScope,
	type Fingerprint,
	type GenerateRequest,
	type GenerateResult,
	type LlmClient,
	LlmError,
	type Message,
	NoViableRoute,
	type Part,
	PRESETS,
	PROVIDERS,
	type Preset,
	type ProposedAction,
	type Provider,
	type StreamEvent,
	type StreamRequest,
	TASKS,
	type Task,
	type Usage,
} from "./lib/types";

/** The User's AI settings as the Settings screen shows them, with today's spend. */
export type AiSettings = {
	preset: Preset;
	taskPresets: Partial<Record<Task, Preset>>;
	dailyCapUsd: number | null;
	timeZone: string;
	spentTodayUsd: number;
};

export async function getAiSettings(exec: Executor, owner: UserId): Promise<AiSettings> {
	const settings = await readSettings(exec, owner);
	return {
		preset: settings.preset,
		taskPresets: settings.taskPresets,
		dailyCapUsd: settings.dailyCapMicroUsd === null ? null : settings.dailyCapMicroUsd / 1e6,
		timeZone: settings.timeZone,
		spentTodayUsd: (await spentTodayMicroUsd(exec, owner, settings.timeZone)) / 1e6,
	};
}

/** Changes some of the User's AI settings; omitted fields keep their value. */
export async function updateAiSettings(
	exec: Executor,
	owner: UserId,
	change: Partial<Omit<AiSettings, "spentTodayUsd">>,
): Promise<void> {
	const current: Settings = await readSettings(exec, owner);
	await writeSettings(exec, owner, {
		preset: change.preset ?? current.preset,
		taskPresets: change.taskPresets ?? current.taskPresets,
		dailyCapMicroUsd:
			change.dailyCapUsd === undefined
				? current.dailyCapMicroUsd
				: change.dailyCapUsd === null
					? null
					: Math.round(change.dailyCapUsd * 1e6),
		timeZone: change.timeZone ?? current.timeZone,
	});
}
