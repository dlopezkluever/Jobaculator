import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fail, ssh, sshHost } from "./ssh";

// Lays ops/host onto the VPS (§17): uploads it over SSH, then runs ops/host/provision.sh as
// root through sudo (which asks for the admin's password). Idempotent; rerun after any change
// under ops/host.  Usage: pnpm ops:provision [--host <user@address>]

const { host, rest } = sshHost(process.argv.slice(2));
if (rest.length > 0) fail("usage: pnpm ops:provision [--host <user@address>]");

// Chromium at the lockfile's Playwright version once the browser package depends on it.
const PLAYWRIGHT_DEFAULT = "1.65.1";
const locked = /^ {2}playwright@(\d+\.\d+\.\d+):/m.exec(readFileSync("pnpm-lock.yaml", "utf8"))?.[1];
const playwright = locked ?? PLAYWRIGHT_DEFAULT;

const REMOTE_DIR = ".jobaculator-provision"; // under the admin's home
const bundle = spawnSync("tar", ["-czf", "-", "-C", "ops/host", "."], { maxBuffer: 64 * 1024 * 1024 });
if (bundle.status !== 0) fail(`tar failed: ${bundle.stderr.toString()}`);

console.log(`uploading ops/host to ${host}`);
const upload = ssh(host, ["sh", "-c", `rm -rf ${REMOTE_DIR} && mkdir ${REMOTE_DIR} && tar -xzf - -C ${REMOTE_DIR}`], {
	input: bundle.stdout,
});
if (upload !== 0) fail("upload failed");

console.log(`provisioning ${host} (Playwright ${playwright}); sudo may ask for your password`);
const status = ssh(host, ["sudo", "bash", `${REMOTE_DIR}/provision.sh`, playwright]);
ssh(host, ["rm", "-rf", REMOTE_DIR]);
process.exit(status);
