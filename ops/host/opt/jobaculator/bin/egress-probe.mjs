// Installed by ops/provision. Tries a TCP connection to each `host:port` (IPv6 as `[addr]:port`)
// and prints one line per target. Exits 0 when none is reachable, 1 when any is.
// `bin/release egress-check` and ops/tests/egress.db.test.ts run it under the worker's IPAddressDeny=.
import { connect } from "node:net";

const TIMEOUT_MS = 2000;

function probe(target) {
	const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(target);
	if (!match) throw new Error(`bad target ${target}`);
	const [, host, port] = match;
	return new Promise((resolve) => {
		const socket = connect({ host, port: Number(port) });
		const done = (reachable, detail) => {
			socket.destroy();
			resolve({ target, reachable, detail });
		};
		socket.setTimeout(TIMEOUT_MS, () => done(false, "timeout"));
		socket.once("connect", () => done(true, "connected"));
		socket.once("error", (error) => done(false, error.code ?? error.message));
	});
}

const results = await Promise.all(process.argv.slice(2).map(probe));
for (const { target, reachable, detail } of results) {
	console.log(`${target} ${reachable ? "reachable" : "unreachable"} (${detail})`);
}
process.exit(results.some((r) => r.reachable) ? 1 : 0);
