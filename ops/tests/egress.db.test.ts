import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The worker's egress block (§14, §17): the IPAddressDeny=/IPAddressAllow= lines of the real
// unit file, enforced by systemd on a probe process, leave the metadata service and Postgres's
// TCP port unreachable. Needs systemd and passwordless sudo (CI runners and orbs have both) and
// Postgres listening on 127.0.0.1:5432, which the control run must reach.
const unit = readFileSync("ops/host/etc/systemd/system/jobaculator-worker.service", "utf8");
const egressProperties = unit
	.split("\n")
	.filter((line) => /^IPAddress(Deny|Allow)=/.test(line))
	.flatMap((line) => ["-p", line]);
const PROBE = resolve("ops/host/opt/jobaculator/bin/egress-probe.mjs");

function probe(properties: string[], targets: string[]) {
	const result = spawnSync(
		"sudo",
		[
			"-n",
			"systemd-run",
			"--quiet",
			"--wait",
			"--pipe",
			"--collect",
			...properties,
			process.execPath,
			PROBE,
			...targets,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0 && result.status !== 1) throw new Error(`systemd-run failed: ${result.stderr}`);
	return Object.fromEntries(
		result.stdout
			.trim()
			.split("\n")
			.map((line) => line.split(" ").slice(0, 2)),
	);
}

describe("worker egress block", () => {
	it("leaves 169.254.169.254 and 127.0.0.1:5432 unreachable, which are reachable without it", () => {
		expect(egressProperties.length).toBeGreaterThan(2);
		expect(probe([], ["127.0.0.1:5432"])).toEqual({ "127.0.0.1:5432": "reachable" });

		expect(
			probe(egressProperties, ["169.254.169.254:80", "127.0.0.1:5432", "[::ffff:127.0.0.1]:5432", "10.0.0.1:80"]),
		).toEqual({
			"169.254.169.254:80": "unreachable",
			"127.0.0.1:5432": "unreachable",
			"[::ffff:127.0.0.1]:5432": "unreachable",
			"10.0.0.1:80": "unreachable",
		});
	});
});
