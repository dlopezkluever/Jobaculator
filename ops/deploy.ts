import { z } from "zod";
import { capture, fail, REPO, ssh, sshHost } from "./ssh";

// Deploys a CI-built release to the VPS (§17). Through your authenticated `gh` it checks that CI
// passed for the commit and reads the tarball's sha256 from the GitHub API (never from what the
// VPS downloads), then runs the root-owned `bin/release` on the host. The VPS never builds.
const USAGE = `usage:
  pnpm ops:deploy <sha or ref> [--force]    activate build-<sha> (--force: don't wait for a live Takeover)
  pnpm ops:deploy --rollback [<sha>]        switch back to the previous (or a named) unpacked release
  pnpm ops:deploy --status
options: --host <user@address> (default: JOBACULATOR_HOST)`;

const { host, rest } = sshHost(process.argv.slice(2));
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const [ref, ...extra] = rest.filter((a) => !a.startsWith("--"));
for (const flag of flags) if (!["--force", "--rollback", "--status"].includes(flag)) fail(USAGE);
if (extra.length > 0) fail(USAGE);

const release = (args: string[]) => process.exit(ssh(host, ["sudo", "/opt/jobaculator/bin/release", ...args]));

if (flags.has("--status")) release(["status"]);
if (flags.has("--rollback")) release(["rollback", ...(ref ? [resolveSha(ref)] : [])]);
if (!ref) fail(USAGE);

const sha = resolveSha(ref);
const tag = `build-${sha}`;

const runs = z
	.array(z.object({ status: z.string(), conclusion: z.string(), url: z.string() }))
	.parse(
		JSON.parse(
			capture("gh", [
				...["run", "list", "-R", REPO, "--commit", sha, "--workflow", "CI", "--event", "push"],
				...["--json", "status,conclusion,url"],
			]),
		),
	);
if (!runs.some((run) => run.status === "completed" && run.conclusion === "success")) {
	const seen = runs.map((run) => `  ${run.status}/${run.conclusion || "-"} ${run.url}`).join("\n");
	fail(`CI has not passed for ${sha}${seen ? `:\n${seen}` : " (no push run found)"}`);
}

const assets = z
	.object({ assets: z.array(z.object({ name: z.string(), digest: z.string().nullish() })) })
	.parse(JSON.parse(capture("gh", ["api", `repos/${REPO}/releases/tags/${tag}`]))).assets;
const tarball = assets.find((asset) => asset.name === `jobaculator-${sha}.tar.gz`);
if (!tarball) fail(`${tag} has no jobaculator-${sha}.tar.gz`);
// CI publishes <tarball>.sha256 beside it; GitHub also records each asset's digest. Both must agree.
const published = capture("gh", [
	"release",
	"download",
	tag,
	"-R",
	REPO,
	"-p",
	`jobaculator-${sha}.tar.gz.sha256`,
	"-O",
	"-",
])
	.trim()
	.split(/\s+/)[0];
const digest = tarball.digest?.replace(/^sha256:/, "");
if (!published || !/^[0-9a-f]{64}$/.test(published)) fail(`${tag} has no valid .sha256 asset`);
if (digest && digest !== published) fail(`${tag}: GitHub's digest ${digest} != published sha256 ${published}`);

console.log(`deploying ${tag} (sha256 ${published}) to ${host}`);
release(["activate", sha, published, ...(flags.has("--force") ? ["--force"] : [])]);

function resolveSha(input: string): string {
	if (/^[0-9a-f]{40}$/.test(input)) return input;
	return capture("gh", ["api", `repos/${REPO}/commits/${input}`, "--jq", ".sha"]).trim();
}
