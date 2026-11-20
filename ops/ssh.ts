import { spawnSync } from "node:child_process";

// Shared by the ops commands, which run from the dev laptop (Windows included) through pnpm.
// They need `ssh` (OpenSSH, built into Windows) and, for deploy, an authenticated `gh`.

export const REPO = "dlopezkluever/Jobaculator";

/** The SSH destination: `--host <dest>` or JOBACULATOR_HOST, such as `daniel@203.0.113.7` or an ~/.ssh/config alias. */
export function sshHost(args: string[]): { host: string; rest: string[] } {
	const index = args.indexOf("--host");
	const host = index >= 0 ? args[index + 1] : process.env.JOBACULATOR_HOST;
	const rest = index >= 0 ? [...args.slice(0, index), ...args.slice(index + 2)] : args;
	if (!host) fail("set JOBACULATOR_HOST or pass --host <user@address>");
	return { host, rest };
}

/** Quotes one argument for the remote POSIX shell that ssh hands its command to. */
export function shellQuote(arg: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Runs `argv` on the host with this terminal attached (so sudo and password prompts work); returns its exit code. */
export function ssh(host: string, argv: string[], options: { input?: Buffer } = {}): number {
	const tty = options.input === undefined && process.stdin.isTTY ? ["-t"] : [];
	const result = spawnSync("ssh", [...tty, host, argv.map(shellQuote).join(" ")], {
		stdio: [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
		input: options.input,
	});
	if (result.error) fail(`could not run ssh: ${result.error.message}`);
	return result.status ?? 1;
}

/** Runs a local command and returns its stdout; fails with its stderr. */
export function capture(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) fail(`could not run ${command}: ${result.error.message}`);
	if (result.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${result.stderr.trim()}`);
	return result.stdout;
}

export function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
