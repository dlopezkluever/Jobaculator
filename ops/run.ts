import { fail, ssh, sshHost } from "./ssh";

// Runs an ops CLI command of the live release on the VPS (§17), as the right unprivileged user,
// through the root-owned `bin/run`. Prompts (such as a password) come to this terminal.
//   pnpm ops:run user:create --email you@example.com --name "Your Name"
//   pnpm ops:run user:reset-password --email you@example.com
// options: --host <user@address> (default: JOBACULATOR_HOST)

const { host, rest } = sshHost(process.argv.slice(2));
if (rest.length === 0)
	fail("usage: pnpm ops:run <command> [args...], such as user:create --email <email> --name <name>");
process.exit(ssh(host, ["sudo", "/opt/jobaculator/bin/run", ...rest]));
