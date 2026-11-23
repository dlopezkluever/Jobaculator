import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createCandidate } from "./packages/candidate/index";
import { type Config, ConfigError, loadConfig } from "./packages/config/index";
import { createDatabase } from "./packages/db/index";
import { createUser, resetPassword, UserError } from "./packages/users/index";

// Admin CLI (§14, §17): the only way to create a User or reset a password. Run on the
// host as `ops/run <command>`, or `pnpm cli <command>` in a checkout. The password is
// read from stdin, never argv, so it stays out of shell history and the process list.
const USAGE = `usage:
  user:create --email <email> --name <name> [--canary]
                                                 password from stdin (prompted twice on a terminal);
                                                 --canary: the canary User, never submitted for
  user:reset-password --email <email>            password from stdin; signs out every session`;

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { email: { type: "string" }, name: { type: "string" }, canary: { type: "boolean" } },
});
const [command] = positionals;

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

async function readPassword(): Promise<string> {
	if (!process.stdin.isTTY) {
		let input = "";
		for await (const chunk of process.stdin) input += chunk;
		return input.replace(/\r?\n$/, "");
	}
	const first = await promptHidden("Password: ");
	if (first !== (await promptHidden("Repeat password: "))) fail("passwords do not match");
	return first;
}

function promptHidden(question: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		// Echo the prompt but not the typed characters.
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
			if (s === question) process.stdout.write(s);
		};
		rl.question(question, (answer) => {
			rl.close();
			process.stdout.write("\n");
			resolve(answer);
		});
	});
}

if (command !== "user:create" && command !== "user:reset-password") fail(USAGE);
if (!values.email) fail(USAGE);
if (command === "user:create" && !values.name) fail(USAGE);

let config: Config<"admin">;
try {
	config = loadConfig("admin");
} catch (error) {
	if (error instanceof ConfigError) fail(`${error.message}\nSet DATABASE_URL to the Postgres database the app uses.`);
	throw error;
}
const database = createDatabase(config.databaseUrl, { max: 1 });
try {
	const password = await readPassword();
	if (command === "user:create") {
		const userId = await database.db.transaction(async (tx) => {
			const id = await createUser(tx, {
				email: values.email ?? "",
				name: values.name ?? "",
				password,
				canary: values.canary ?? false,
			});
			await createCandidate(tx, id);
			return id;
		});
		process.stdout.write(`created User ${userId} and its Candidate\n`);
	} else {
		await resetPassword(database.db, { email: values.email, password });
		process.stdout.write("password reset; every session is signed out\n");
	}
} catch (error) {
	if (error instanceof UserError) fail(error.message);
	throw error;
} finally {
	await database.close();
}
